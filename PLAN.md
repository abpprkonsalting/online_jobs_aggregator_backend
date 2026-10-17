# Project Development Plan: Rezi Map Job Extractor

## 1. Problem Statement

We need a job-extraction platform. The design must be **modular** and **technology-agnostic**, prepared for different data sources, some of which may require web scraping, different API protocols, or other delivery mechanisms. New sources must be able to be added without modifying core logic.

The first phase will be:
1. Extract job postings from `https://map.rezi.ai/` filtered by geographic location — using the open, unauthenticated API endpoints already discovered.
2. Identify which of those job postings are **programming-related**.
3. Classify each programming job by **how long it has been waiting to be filled** (based on `date_posted`).
4. Present the results as a **sorted, filterable list** for review and downstream use.

---

## 2. Current State / Knowns

### 2.1 Data sources (first source)

The first source is the Rezi map endpoint. Two endpoints are confirmed via HAR inspection:

| Endpoint | Method | Auth | Notes |
|----------|--------|------|-------|
| `https://maps-cdn.rezi.ai/jobs/jobs_v2.pmtiles` | GET (Range) | None | PMTiles v3 spatial index; each tile contains varint-encoded `obfuscated_id` values for jobs in that tile's geographic area. Total file ~775 MB; we fetch only tile byte ranges covering the target area. |
| `https://api.rezi.ai/v1/search-engine/maps/jobs/details?page=1&rows_per_page=9` | POST | None | Accepts JSON body `{"obfuscated_ids":[...]}` (observed max 9 IDs per call). Returns full job records. |

### 2.2 Job record fields (from `output.json` / `jobs_output.json`)

Core fields useful for filtering and classification:

- `obfuscated_id` (int) — unique job identifier used in API calls
- `title` (string) — job title
- `organization` (string) — employer name
- `job_url` (string) — application URL
- `date_posted` (ISO-8601 string) — used to compute "days waiting to be filled"
- `locations_derived` (array of strings) — geographic locations
- `countries_derived` (array or null)
- `cities_derived` (array or null)
- `remote_derived` (boolean)
- `work_arrangement` (string)
- `salary_min_value`, `salary_max_value`, `salary_currency`, `salary_unit_text`
- `ai_salary_min_value`, `ai_salary_max_value`, `ai_salary_currency`, `ai_salary_unit_text`
- `ai_key_skills` (array of strings) — **primary field for programming detection** (e.g., "Python", "SQL", "AWS", "machine learning", "C++")
- `employment_type` (string or null)
- `experience_level` (string)
- `description_text` (string) — full job description
- `frontend_payload` (object) — enriched structured data including `skills`, `requirements`, `responsibilities`, `education_level`, `work_type`, `about_role`, `annual_salary`, `benefits`, etc.

### 2.3 Technical constraints & observations

- No authentication required on the first source endpoints.
- Details API accepts ~9 `obfuscated_ids` per POST call (observed).
- PMTiles file is ~775 MB; only tile ranges covering the user's bounding box should be downloaded.
- Tiles not present in the directory are empty (no jobs in that area).
- Tile compression is GZIP (PMTiles v3).
- `date_posted` values are in the past (e.g., July 2026), so "waiting time" = today − date_posted.

---

## 3. Requirements

### 3.1 Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-01 | Accept a geographic area as input (bounding box: min_lat, min_lng, max_lat, max_lng) and a zoom level. | High |
| FR-02 | Compute the PMTiles (z, x, y) tiles covering that area using Web Mercator math. | High |
| FR-03 | Fetch only the required byte ranges from `jobs_v2.pmtiles` via HTTP Range requests (no full-file download). | High |
| FR-04 | Parse PMTiles v3 header + directory to resolve tile byte offsets/lengths. | High |
| FR-05 | Decompress gzip tile payloads and extract varint-encoded `obfuscated_id` values. | High |
| FR-06 | POST batches of ≤9 `obfuscated_ids` to the details API and collect full job records. | High |
| FR-07 | Apply configurable rate limiting and retry logic between API batches. | High |
| FR-08 | Filter jobs for **programming-related** roles using `ai_key_skills`, `title`, `frontend_payload.skills`, and/or `description_text`. | High |
| FR-09 | Compute "days waiting to be filled" = current date − `date_posted`. | High |
| FR-10 | Sort results by waiting time (oldest first = waiting longest). | High |
| FR-11 | Allow optional additional filters: salary range, remote/onsite, country/city, experience level, employment type. | Medium |
| FR-12 | Output results as a list (JSON, CSV, and/or SQLite). | High |
| FR-13 | Support incremental/resumable runs (cache fetched tile ranges and job details to avoid re-fetching). | Medium |
| FR-14 | CLI interface for all inputs and outputs, including source selection. | High |
| FR-15 | Log progress (tiles processed, IDs extracted, API batches completed, jobs saved). | Medium |
| FR-16 | Support pluggable source adapters so new data sources can be added without modifying core pipeline logic. | High |

### 3.2 Non-Functional Requirements

| ID | Requirement |
|----|-------------|
| NF-01 | Architecture must support multiple source types (API-based, scraping-based, hybrid) via a common adapter interface. |
| NF-02 | Core pipeline (filter, classify, output, cache) must operate on a normalized job record schema independent of the source. |
| NF-03 | Respectful rate limiting to avoid overwhelming any API or server. |
| NF-04 | Project-local Python virtual environment (no system-wide package installs). |
| NF-05 | Deterministic output for the same input area and zoom. |

---

## 4. System Architecture (High-Level)

```
┌─────────────────────────────────────────────────────────────┐
│                      CLI / User Input                       │
│  (bbox, zoom, source, filters, output format, max_batches)  │
└─────────────────────────────────────────────────────────────┘
                               │
┌─────────────────────────────▼─────────────────────────────┐
│                    Orchestration Layer                      │
│  1. Select source adapter                                    │
│  2. Source adapter fetches raw job records                  │
│  3. Normalize records to common job schema                  │
│  4. Apply programming filter                                │
│  5. Compute waiting time & sort                             │
│  6. Write output                                            │
│                                                             │
│  Source adapters are pluggable; core pipeline logic is      │
│  independent of any specific technology (API, scraping, etc.)│
└─────────────────────────────────────────────────────────────┘
                               │
         ┌─────────────────────┼─────────────────────┐
         ▼                     ▼                     ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│ Source        │   │  Shared       │   │   Cache/DB    │
│ Adapters      │   │  Pipeline     │   │   (SQLite)    │
│ (rezi, future │   │  (filter,     │   │               │
│  scrape, etc.)│   │  classify,    │   │               │
│               │   │  output)      │   │               │
└───────────────┘   └───────────────┘   └───────────────┘
```

### 4.1 Modules

**Source adapters (pluggable):**

1. **`sources/base.py`** — Abstract base class / Protocol defining the `JobSource` interface: `fetch_jobs(bbox, zoom) -> Iterator[dict]`. Each source implements its own fetch logic (API, scraping, etc.).
2. **`sources/rezi/__init__.py`** — Rezi source package; registers the `ReziSource` adapter.
3. **`sources/rezi/tiles.py`** — Web Mercator math; compute tiles for a bounding box at a zoom level.
4. **`sources/rezi/pmtiles.py`** — PMTiles v3 header/directory parser; HTTP range source; tile offset resolution.
5. **`sources/rezi/ids.py`** — Varint scanning; deduplication of `obfuscated_id` values.
6. **`sources/rezi/api.py`** — Details API client; batching (≤9 IDs); rate limiting; retry with backoff.
7. **`sources/rezi/normalize.py`** — Maps Rezi-specific fields to the common `JobRecord` schema.

**Shared core pipeline:**

8. **`models.py`** — Normalized `JobRecord` schema (common fields used across all sources).
9. **`pipeline.py`** — Orchestration: selects source adapter, normalizes records, runs filter → classify → output.
10. **`filter.py`** — Programming-job detection (skills, title, description); additional filters (salary, remote, location).
11. **`classify.py`** — Compute days waiting from `date_posted`; sort by waiting time.
12. **`output.py`** — Write results to JSON / CSV / SQLite.
13. **`cache.py`** — Optional SQLite cache for fetched tile ranges and job details.
14. **`cli.py`** — Argument parsing, input validation, progress reporting, source selection.

---

## 5. Data Flow

1. **Input**: Bounding box + zoom + source → CLI
2. **Source selection**: CLI selects adapter, calls `source.fetch_jobs(bbox, zoom)`
3. **Rezi source (first source)**:
   a. Tile computation: Bbox + zoom → list of (z, x, y) tiles
   b. Offset resolution: Tile list + PMTiles directory → list of (tile_offset, tile_length)
   c. Tile fetch: Range requests → gzip-decompressed tile bytes
   d. ID extraction: Tile bytes → set of `obfuscated_id` ints
   e. API batching: ID set → batches of 9 → POST requests → raw job records
4. **Normalization**: Raw job records → normalized `JobRecord` schema via source-specific `normalize.py`
5. **Filtering**: Job records → programming-related subset
6. **Classification**: Compute `days_waiting` = now − `date_posted`
7. **Sorting**: Descending by `days_waiting` (longest waiting first)
8. **Output**: JSON / CSV / SQLite file

---

## 6. Programming Detection Logic (FR-08)

A job is considered **programming-related** if ANY of the following is true:

- `ai_key_skills` contains a programming keyword (Python, Java, JavaScript, C++, C#, Go, Ruby, PHP, Swift, Kotlin, Rust, SQL, AWS, Docker, Kubernetes, Git, React, Angular, Vue, Node.js, Django, Flask, machine learning, deep learning, NLP, artificial intelligence, data engineering, backend, frontend, fullstack, software engineer, developer, programmer, DevOps, SRE, etc.)
- `title` contains engineering/developer keywords (Engineer, Developer, Programmer, Architect, DevOps, SRE, ML Engineer, Data Engineer, Backend, Frontend, Full Stack)
- `frontend_payload.skills` contains programming keywords
- `description_text` contains code/language mentions (optional, lower confidence)

---

## 7. Waiting Time Classification (FR-09)

- `days_waiting` = `(current_utc_date − date_posted).days`
- Categories (optional labels):
  - `fresh`: 0–7 days
  - `recent`: 8–30 days
  - `aging`: 31–60 days
  - `stale`: 61–90 days
  - `stalled`: 90+ days
- Sort order: `days_waiting` descending (oldest postings first)

---

## 8. Deliverables / File Plan

| File | Purpose |
|------|---------|
| `sources/base.py` | Abstract `JobSource` adapter interface |
| `sources/rezi/` | Rezi source adapter package (tiles, pmtiles, ids, api, normalize) |
| `models.py` | Normalized `JobRecord` schema |
| `pipeline.py` | Orchestration: source → normalize → filter → classify → output |
| `cli.py` | CLI entry point (source selection, filters, output format) |
| `filter.py` | Programming-job detection and additional filters |
| `classify.py` | Days-waiting computation and sorting |
| `output.py` | JSON / CSV / SQLite writers |
| `cache.py` | SQLite cache for resumable runs |
| `requirements.txt` | Python dependencies (`requests`, `pmtiles`) |
| `.venv/` | Project-local virtual environment |
| `jobs_output.json` | Sample output from test run |
| `obfuscated_ids_batches.json` | Pre-extracted ID batches (reference) |
| `PLAN.md` | This document |
| `README.md` | Usage instructions (to be written) |

---

## 9. Implementation Roadmap (Suggested Order)

| Phase | Task | Description |
|-------|------|-------------|
| 1 | Create core schema & adapter interface | Define `JobRecord` in `models.py` and `JobSource` interface in `sources/base.py` |
| 2 | Refactor Rezi extractor into source adapter | Move `tiles.py`, `pmtiles.py`, `ids.py`, `api.py` into `sources/rezi/`, add `normalize.py` |
| 3 | Build orchestration pipeline | `pipeline.py` ties source → normalize → filter → classify → output together |
| 4 | Add programming filter | Implement `filter.py` with keyword lists on `ai_key_skills`, `title`, etc. |
| 5 | Add waiting-time classification | Implement `classify.py` with `days_waiting` computation and sorting |
| 6 | Add output formats | CSV and SQLite writers in addition to JSON |
| 7 | Add caching layer | SQLite cache for tile ranges and job details (resumable runs) |
| 8 | Add CLI filters | Salary range, remote, country, experience level, min/max days waiting |
| 9 | Testing | Validate against NYC and other areas; verify filter accuracy |
| 10 | Documentation | `README.md` with usage examples |

---

## 10. Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| API rate limiting / blocking | Configurable `api_delay`; retry with exponential backoff; process in small batches |
| PMTiles directory format changes | Use the `pmtiles` library for robust parsing; don't hand-roll directory parsing |
| Missing tiles in directory | Treat missing tiles as empty (no jobs); log count |
| `date_posted` in the future or missing | Clamp `days_waiting` to ≥0; skip jobs without `date_posted` or mark as unknown |
| Large areas → many tiles → many API batches | `max_batches` CLI option; warn user about estimated batch count before starting |
| Source schema drift across future adapters | Normalized `JobRecord` schema with per-source normalization functions |
| New sources require different fetch mechanisms (e.g., scraping) | Adapter interface (`JobSource`) isolates source-specific logic from core pipeline |

---

## 11. Next Step

Create the module scaffold (`models.py`, `sources/base.py`, `sources/rezi/`), `requirements.txt`, and `.venv`, then refactor the working extractor into the modular structure above.