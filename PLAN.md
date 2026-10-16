# Project Development Plan: Rezi Map Job Extractor

## 1. Problem Statement

We need a system that:
1. Extracts job postings from `https://map.rezi.ai/` filtered by geographic location — without web scraping (using the open, unauthenticated API endpoints already discovered).
2. Identifies which of those job postings are **programming-related**.
3. Classifies each programming job by **how long it has been waiting to be filled** (based on `date_posted`).
4. Presents the results as a **sorted, filterable list** for review and downstream use.

---

## 2. Current State / Knowns

### 2.1 Data sources (confirmed via HAR inspection)

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

- No authentication required on either endpoint.
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
| FR-14 | CLI interface for all inputs and outputs. | High |
| FR-15 | Log progress (tiles processed, IDs extracted, API batches completed, jobs saved). | Medium |

### 3.2 Non-Functional Requirements

| ID | Requirement |
|----|-------------|
| NF-01 | No web scraping of HTML pages; only the two open API endpoints. |
| NF-02 | No authentication tokens, cookies, or headers beyond standard HTTP. |
| NF-03 | Respectful rate limiting to avoid overwhelming the API. |
| NF-04 | Project-local Python virtual environment (no system-wide package installs). |
| NF-05 | Deterministic output for the same input area and zoom. |

---

## 4. System Architecture (High-Level)

```
┌─────────────────────────────────────────────────────────────┐
│                      CLI / User Input                       │
│  (bbox, zoom, filters, output format, max_batches, delay)   │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────▼─────────────────────────────┐
│                    Orchestration Layer                      │
│  1. Compute tiles for bbox                                  │
│  2. Resolve tile offsets in PMTiles directory               │
│  3. Fetch tile byte ranges (parallel, cached)               │
│  4. Extract obfuscated_ids from tiles                       │
│  5. Batch POST to details API                               │
│  6. Apply programming filter                                │
│  7. Compute waiting time & sort                             │
│  8. Write output                                            │
└─────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│   PMTiles     │   │ Details API   │   │   Cache/DB    │
│   Resolver    │   │   Client      │   │   (SQLite)    │
└───────────────┘   └───────────────┘   └───────────────┘
```

### 4.1 Modules

1. **`cli.py`** — Argument parsing, input validation, progress reporting.
2. **`tiles.py`** — Web Mercator math; compute tiles for a bounding box at a zoom level.
3. **`pmtiles.py`** — PMTiles v3 header/directory parser; HTTP range source; tile offset resolution.
4. **`ids.py`** — Varint scanning; deduplication of `obfuscated_ids`.
5. **`api.py`** — Details API client; batching (≤9 IDs); rate limiting; retry with backoff.
6. **`filter.py`** — Programming-job detection (skills, title, description); additional filters (salary, remote, location).
7. **`classify.py`** — Compute days waiting from `date_posted`; sort by waiting time.
8. **`output.py`** — Write results to JSON / CSV / SQLite.
9. **`cache.py`** — Optional SQLite cache for fetched tile ranges and job details.

---

## 5. Data Flow

1. **Input**: Bounding box + zoom → CLI
2. **Tile computation**: Bbox + zoom → list of (z, x, y) tiles
3. **Offset resolution**: Tile list + PMTiles directory → list of (tile_offset, tile_length)
4. **Tile fetch**: Range requests → gzip-decompressed tile bytes
5. **ID extraction**: Tile bytes → set of `obfuscated_id` ints
6. **API batching**: ID set → batches of 9 → POST requests → job records
7. **Filtering**: Job records → programming-related subset
8. **Classification**: Compute `days_waiting` = now − `date_posted`
9. **Sorting**: Descending by `days_waiting` (longest waiting first)
10. **Output**: JSON / CSV / SQLite file

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
| `map_rezi_jobs_extractor.py` | Core extraction script (already implemented, to be refactored into modules) |
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
| 1 | Refactor extractor into modules | Split `map_rezi_jobs_extractor.py` into `cli.py`, `tiles.py`, `pmtiles.py`, `ids.py`, `api.py`, `filter.py`, `classify.py`, `output.py`, `cache.py` |
| 2 | Add programming filter | Implement `filter.py` with keyword lists on `ai_key_skills`, `title`, etc. |
| 3 | Add waiting-time classification | Implement `classify.py` with `days_waiting` computation and sorting |
| 4 | Add output formats | CSV and SQLite writers in addition to JSON |
| 5 | Add caching layer | SQLite cache for tile ranges and job details (resumable runs) |
| 6 | Add CLI filters | Salary range, remote, country, experience level, min/max days waiting |
| 7 | Testing | Validate against NYC and other areas; verify filter accuracy |
| 8 | Documentation | `README.md` with usage examples |

---

## 10. Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| API rate limiting / blocking | Configurable `api_delay`; retry with exponential backoff; process in small batches |
| PMTiles directory format changes | Use the `pmtiles` library for robust parsing; don't hand-roll directory parsing |
| Missing tiles in directory | Treat missing tiles as empty (no jobs); log count |
| `date_posted` in the future or missing | Clamp `days_waiting` to ≥0; skip jobs without `date_posted` or mark as unknown |
| Large areas → many tiles → many API batches | `max_batches` CLI option; warn user about estimated batch count before starting |

---

## 11. Next Step

Create the module scaffold and `requirements.txt`, then refactor the working extractor into the modular structure above.
