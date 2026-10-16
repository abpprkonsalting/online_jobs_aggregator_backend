#!/usr/bin/env python3
"""
map_rezi_jobs_extractor.py

Extract job postings from https://map.rezi.ai/ for a geographic area, without scraping.

Pipeline:
  1. Accept a bounding box (min_lat, min_lng, max_lat, max_lng) and a zoom level.
  2. Compute the PMTiles (z, x, y) tiles that cover the box (Web Mercator).
  3. Resolve each tile to byte offsets inside jobs_v2.pmtiles (PMTiles header + directory).
  4. Fetch only those byte ranges via HTTP Range requests.
  5. Decompress gzip tiles and scan for varint-encoded obfuscated_id values.
  6. POST batches (<=9 ids) to the details API.
  7. Save all results to a JSON file.

Endpoints used (both unauthenticated, confirmed via HAR):
  GET  https://maps-cdn.rezi.ai/jobs/jobs_v2.pmtiles      (Range requests)
  POST https://api.rezi.ai/v1/search-engine/maps/jobs/details?page=1&rows_per_page=9

Dependencies:
  pip install requests pmtiles

Usage:
  python map_rezi_jobs_extractor.py <min_lat> <min_lng> <max_lat> <max_lng> <zoom>

Example (New York City area):
  python map_rezi_jobs_extractor.py 40.4774 -74.2591 40.9176 -73.7004 12

Output: jobs_output.json
"""

import gzip
import io
import json
import math
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Set, Dict, Tuple, List, Optional, Callable

import requests
from pmtiles.tile import (
    deserialize_header,
    deserialize_directory,
    zxy_to_tileid,
    find_tile,
    Compression,
)


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
PMTILES_URL = "https://maps-cdn.rezi.ai/jobs/jobs_v2.pmtiles"
DETAILS_URL = "https://api.rezi.ai/v1/search-engine/maps/jobs/details"
DETAILS_PAGE = 1
DETAILS_ROWS_PER_PAGE = 9
MAX_IDS_PER_REQUEST = 9          # observed limit from the website (9 ids per POST)
OUTPUT_FILE = "jobs_output.json"
DEFAULT_MAX_BATCHES = None       # None = process all batches
API_DELAY_SECONDS = 0.5          # delay between API batches to avoid rate limiting

# Varint scan window: obfuscated_ids observed are ~37M-42M, but keep wide.
ID_MIN = 10_000_000
ID_MAX = 100_000_000


# ---------------------------------------------------------------------------
# HTTP range source with caching (for pmtiles Reader)
# ---------------------------------------------------------------------------
class HTTPSource:
    """Provides get_bytes(offset, length) via HTTP Range requests, with caching."""

    def __init__(self, url: str):
        self.url = url
        self._cache: Dict[Tuple[int, int], bytes] = {}

    def get_bytes(self, offset: int, length: int) -> bytes:
        key = (offset, length)
        if key in self._cache:
            return self._cache[key]
        headers = {"Range": f"bytes={offset}-{offset + length - 1}"}
        resp = requests.get(self.url, headers=headers, timeout=60)
        resp.raise_for_status()
        data = resp.content
        self._cache[key] = data
        return data


# ---------------------------------------------------------------------------
# Web Mercator tile math
# ---------------------------------------------------------------------------
def lat_lng_to_tile(lat: float, lng: float, zoom: int) -> Tuple[int, int]:
    """Convert lat/lng to Web Mercator tile (x, y) at the given zoom."""
    n = 2 ** zoom
    x = int((lng + 180.0) / 360.0 * n)
    lat_rad = math.radians(lat)
    y = int((1.0 - math.log(math.tan(lat_rad) + 1.0 / math.cos(lat_rad)) / math.pi) / 2.0 * n)
    return x, y


def tiles_for_bbox(
    min_lat: float, min_lng: float, max_lat: float, max_lng: float, zoom: int
) -> List[Tuple[int, int, int]]:
    """Return list of (zoom, x, y) tiles whose extent intersects the bounding box."""
    x_min, y_max = lat_lng_to_tile(max_lat, min_lng, zoom)
    x_max, y_min = lat_lng_to_tile(min_lat, max_lng, zoom)
    x0, x1 = sorted([x_min, x_max])
    y0, y1 = sorted([y_min, y_max])
    tiles = []
    for x in range(x0, x1 + 1):
        for y in range(y0, y1 + 1):
            tiles.append((zoom, x, y))
    return tiles


# ---------------------------------------------------------------------------
# Varint extraction from decompressed tile data
# ---------------------------------------------------------------------------
def decode_varint(data: bytes, pos: int) -> Tuple[Optional[int], int]:
    """Decode a protobuf-style unsigned varint. Returns (value, new_pos)."""
    result = 0
    shift = 0
    while pos < len(data):
        b = data[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if not (b & 0x80):
            return result, pos
        shift += 7
        if shift > 63:
            return None, pos
    return None, pos


def extract_candidate_ids(
    decompressed: bytes, min_id: int = ID_MIN, max_id: int = ID_MAX
) -> Set[int]:
    """Scan decompressed tile bytes for varint-encoded integers in [min_id, max_id]."""
    ids: Set[int] = set()
    pos = 0
    while pos < len(decompressed) - 1:
        val, new_pos = decode_varint(decompressed, pos)
        if val is not None and min_id <= val <= max_id:
            ids.add(val)
        pos = new_pos if new_pos > pos else pos + 1
    return ids


def decompress_tile(data: bytes, compression: Compression) -> bytes:
    """Decompress tile data according to the PMTiles tile_compression setting."""
    if compression == Compression.GZIP:
        return gzip.decompress(data)
    if compression == Compression.NONE:
        return data
    if compression == Compression.BROTLI:
        try:
            import brotli
            return brotli.decompress(data)
        except ImportError:
            raise RuntimeError("brotli package required for Brotli-compressed tiles")
    if compression == Compression.ZSTD:
        try:
            import zstandard
            return zstandard.ZstdDecompressor().decompress(data)
        except ImportError:
            raise RuntimeError("zstandard package required for Zstd-compressed tiles")
    # Compression.UNKNOWN or other: return as-is
    return data


# ---------------------------------------------------------------------------
# Tile resolution via PMTiles directory
# ---------------------------------------------------------------------------
def resolve_tile_offsets(
    source: HTTPSource, header: dict, tiles: List[Tuple[int, int, int]]
) -> Dict[Tuple[int, int, int], Tuple[int, int]]:
    """
    For each (z,x,y) tile, resolve its (offset, length) inside the pmtiles file.

    Returns a dict mapping (z,x,y) -> (tile_data_offset, tile_data_length).
    Tiles not found in the directory are omitted.
    """
    tile_data_offset = header["tile_data_offset"]
    root_offset = header["root_offset"]
    root_length = header["root_length"]
    leaf_dir_offset = header["leaf_directory_offset"]

    # Read and deserialize the root directory (gzipped)
    root_dir_bytes = source.get_bytes(root_offset, root_length)
    root_entries = deserialize_directory(root_dir_bytes)

    resolved: Dict[Tuple[int, int, int], Tuple[int, int]] = {}

    for z, x, y in tiles:
        tile_id = zxy_to_tileid(z, x, y)
        dir_offset = root_offset
        dir_length = root_length
        found = False

        for _depth in range(4):  # max directory depth
            directory = deserialize_directory(source.get_bytes(dir_offset, dir_length))
            result = find_tile(directory, tile_id)
            if result is None:
                break
            if result.run_length > 0:
                # Direct tile data entry
                abs_offset = tile_data_offset + result.offset
                resolved[(z, x, y)] = (abs_offset, result.length)
                found = True
                break
            else:
                # Directory pointer: descend into leaf directory
                dir_offset = leaf_dir_offset + result.offset
                dir_length = result.length

        if not found:
            # Tile not in directory (empty tile)
            pass

    return resolved


# ---------------------------------------------------------------------------
# Details API
# ---------------------------------------------------------------------------
def post_details(obfuscated_ids: List[int]) -> dict:
    """POST a batch of obfuscated_ids to the details API and return parsed JSON."""
    body = {"obfuscated_ids": obfuscated_ids}
    url = f"{DETAILS_URL}?page={DETAILS_PAGE}&rows_per_page={DETAILS_ROWS_PER_PAGE}"
    resp = requests.post(url, json=body, timeout=60)
    resp.raise_for_status()
    return resp.json()


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------
def main(
    min_lat: float,
    min_lng: float,
    max_lat: float,
    max_lng: float,
    zoom: int,
    output: str = OUTPUT_FILE,
    max_batches: Optional[int] = DEFAULT_MAX_BATCHES,
    api_delay: float = API_DELAY_SECONDS,
) -> None:
    source = HTTPSource(PMTILES_URL)

    print(f"[1/6] Reading PMTiles header from {PMTILES_URL} ...")
    header = deserialize_header(source.get_bytes(0, 127))
    print(
        f"    version={header['version']}, "
        f"zoom={header['min_zoom']}-{header['max_zoom']}, "
        f"root_dir={header['root_length']}B @ {header['root_offset']}, "
        f"tile_data={header['tile_data_length']}B @ {header['tile_data_offset']}, "
        f"tile_compression={header['tile_compression'].name}"
    )
    print(f"    bounds: ({header['min_lat_e7']/1e7:.4f},{header['min_lon_e7']/1e7:.4f}) - "
          f"({header['max_lat_e7']/1e7:.4f},{header['max_lon_e7']/1e7:.4f})")

    print(
        f"[2/6] Computing tiles for bbox "
        f"({min_lat},{min_lng})-({max_lat},{max_lng}) at zoom {zoom} ..."
    )
    tiles = tiles_for_bbox(min_lat, min_lng, max_lat, max_lng, zoom)
    print(f"    {len(tiles)} tiles")

    print("[3/6] Resolving tile offsets in PMTiles directory ...")
    resolved = resolve_tile_offsets(source, header, tiles)
    print(f"    {len(resolved)} tiles found in directory ({len(tiles) - len(resolved)} empty)")

    print("[4/6] Fetching tile data and extracting obfuscated_ids ...")
    all_ids: Set[int] = set()
    tile_compression = header["tile_compression"]
    resolved_items = sorted(resolved.items())

    def fetch_and_extract(item):
        (z, x, y), (offset, length) = item
        data = source.get_bytes(offset, length)
        try:
            decompressed = decompress_tile(data, tile_compression)
        except Exception as exc:
            return (z, x, y), set(), f"decompress error: {exc}"
        ids = extract_candidate_ids(decompressed)
        return (z, x, y), ids, None

    max_workers = min(8, len(resolved_items))
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {executor.submit(fetch_and_extract, item): item for item in resolved_items}
        completed = 0
        for future in as_completed(futures):
            (z, x, y), ids, error = future.result()
            if error:
                print(f"    WARNING: tile {z}/{x}/{y}: {error}")
            all_ids.update(ids)
            completed += 1
            if completed % 10 == 0 or completed == len(resolved_items):
                print(f"    processed {completed}/{len(resolved_items)} tiles, "
                      f"{len(all_ids)} unique IDs so far")

    print(f"    {len(all_ids)} unique obfuscated_ids extracted")

    if not all_ids:
        print("    No IDs found; nothing to POST. Try a wider bbox or higher zoom.")
        return

    print("[5/6] Posting ID batches to the details API ...")
    id_list = sorted(all_ids)
    all_jobs: List[dict] = []
    total_batches = (len(id_list) + MAX_IDS_PER_REQUEST - 1) // MAX_IDS_PER_REQUEST
    if max_batches is not None:
        total_batches = min(total_batches, max_batches)

    for i in range(0, len(id_list), MAX_IDS_PER_REQUEST):
        if max_batches is not None and i // MAX_IDS_PER_REQUEST >= max_batches:
            break
        batch = id_list[i : i + MAX_IDS_PER_REQUEST]
        batch_num = i // MAX_IDS_PER_REQUEST + 1
        print(f"    batch {batch_num}/{total_batches}: {len(batch)} ids ...")
        try:
            result = post_details(batch)
        except Exception as exc:
            print(f"    ERROR on batch {batch_num}: {exc}")
            continue
        jobs = result.get("data", {}).get("jobs", [])
        all_jobs.extend(jobs)
        if api_delay > 0:
            time.sleep(api_delay)

    print(f"[6/6] Saving {len(all_jobs)} jobs to {output} ...")
    with open(output, "w") as f:
        json.dump({"jobs": all_jobs, "count": len(all_jobs)}, f, indent=2)
    print("    Done.")


if __name__ == "__main__":
    if len(sys.argv) < 6 or len(sys.argv) > 8:
        print("Usage: python map_rezi_jobs_extractor.py <min_lat> <min_lng> <max_lat> <max_lng> <zoom> [max_batches] [api_delay]")
        print("")
        print("Arguments:")
        print("  min_lat     : southern latitude  (e.g. 40.4774)")
        print("  min_lng     : western longitude  (e.g. -74.2591)")
        print("  max_lat     : northern latitude  (e.g. 40.9176)")
        print("  max_lng     : eastern longitude  (e.g. -73.7004)")
        print("  zoom        : PMTiles zoom level (e.g. 12)")
        print("  max_batches : optional, max API batches to process (default: all)")
        print("  api_delay   : optional, seconds to sleep between API batches (default: 0.5)")
        print("")
        print("Example (New York City, test with 10 batches):")
        print("  python map_rezi_jobs_extractor.py 40.4774 -74.2591 40.9176 -73.7004 12 10")
        print("")
        print("Setup:")
        print("  python3 -m venv .venv")
        print("  source .venv/bin/activate")
        print("  pip install requests pmtiles")
        sys.exit(1)

    min_lat = float(sys.argv[1])
    min_lng = float(sys.argv[2])
    max_lat = float(sys.argv[3])
    max_lng = float(sys.argv[4])
    zoom = int(sys.argv[5])
    max_batches = int(sys.argv[6]) if len(sys.argv) > 6 else None
    api_delay = float(sys.argv[7]) if len(sys.argv) > 7 else API_DELAY_SECONDS
    main(min_lat, min_lng, max_lat, max_lng, zoom, max_batches=max_batches, api_delay=api_delay)
