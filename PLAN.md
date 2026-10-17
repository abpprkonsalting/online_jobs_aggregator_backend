# Project Development Plan: Job Extraction Platform

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
| FR-12 | Provide a web interface and a REST API to interact with the system. | High |
| FR-13 | Support incremental/resumable runs via backend storage (persist fetched tile ranges and job details to avoid re-fetching). | Medium |
| FR-14 | Backend daemon to periodically query configured job sources and update stored job data. | High |
| FR-15 | Log progress (tiles processed, IDs extracted, API batches completed, jobs saved). | Medium |
| FR-16 | Support pluggable source adapters so new data sources can be added without modifying core pipeline logic. | High |

### 3.2 Non-Functional Requirements

| ID | Requirement |
|----|-------------|
| NF-01 | Architecture must support multiple source types (API-based, scraping-based, hybrid) via a common adapter interface. |
| NF-02 | Core pipeline (filter, classify, processing logic) must operate on a normalized job record schema independent of the source. |
| NF-03 | Respectful rate limiting to avoid overwhelming any API or server. |
| NF-04 | Backend: Node.js with Express. Frontend (first version): Angular. |
| NF-05 | Database: to be determined later (with MySQL as a strong candidate). |
| NF-06 | Data model: to be determined later. |
| NF-07 | Deterministic processing for the same input area and zoom. |

---

## 4. System Architecture (High-Level)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Frontend (Angular)                              │
│                     Web UI for browsing, filtering, sorting                │
│                         Job listings (programming-related)                 │
└─────────────────────────────────────────────────────────────────────────┘
                                        │
                                   REST API
                                        │
┌───────────────────────────────▼───────────────────────────────────────────┐
│                            Backend (Node.js + Express)                      │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                          REST API Layer                              │   │
│  │               Endpoints for querying, filtering, sorting jobs         │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                        │                                    │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                        Orchestration/Pipeline                        │   │
│  │  - Source adapter selection & execution                              │   │
│  │  - Normalization to common job schema                                │   │
│  │  - Programming filter & classification (waiting time, etc.)          │   │
│  │  - Pluggable source adapters (API, scraping, hybrid)                 │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                        │                                    │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                           Daemon / Job Fetcher                       │   │
│  │           Periodically queries job sources (first: Rezi map)         │   │
│  │           Persists results to database; avoids re-fetching where     │   │
│  │           possible                                                    │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
                                        │
                                      Database
                                   (TBD; MySQL candidate)
                                        │
                                  Source Adapters
                               (Rezi API, future sources)
```

### 4.1 Components

**Frontend (Angular — first version):**

- Web interface to view, filter, and sort programming-related jobs by waiting time and other filters (location, remote/onsite, salary range, experience level, employment type, etc.).
- Communicates with the backend via REST API.

**Backend (Node.js + Express):**

- **REST API Layer**: Exposes endpoints to query, filter, and sort jobs stored in the database.
- **Source Adapters (pluggable)**: Modular adapters implementing a common interface (`JobSource`). Each adapter encapsulates source-specific logic (API calls, scraping, etc.). First adapter: Rezi map.
  - `sources/base/JobSource` (interface/contract)
  - `sources/rezi/` — Rezi implementation (tiles/PMTiles parsing, ID extraction, details API, normalization)
- **Core Pipeline**: Normalization to a common `JobRecord` schema, programming detection, waiting-time classification, and sorting — independent of any specific source.
- **Job Fetcher Daemon**: Background process that periodically runs configured source adapters, processes results through the pipeline, and persists normalized job records to the database. Supports incremental/resumable behavior.
- **Database Layer**: Persistence for job records, metadata (e.g., fetched ranges, last run timestamps) to support deduplication, incremental updates, and resumability. Database and schema are TBD (MySQL candidate).

---

## 5. Data Flow

1. **Configuration**: Sources, areas (bounding boxes/zooms), filters, and schedule configured via backend/API or environment (as needed).
2. **Periodic fetch (daemon)**: Daemon triggers enabled source adapters on schedule.
3. **Rezi source (first source)**:
   a. Tile computation: Bbox + zoom → list of (z, x, y) tiles
   b. Offset resolution: Tile list + PMTiles directory → list of (tile_offset, tile_length)
   c. Tile fetch: Range requests → gzip-decompressed tile bytes
   d. ID extraction: Tile bytes → set of `obfuscated_id` ints
   e. API batching: ID set → batches of 9 → POST requests → raw job records
4. **Normalization**: Raw job records → normalized `JobRecord` schema via source-specific normalizer.
5. **Processing**: Apply programming filter; compute `days_waiting` = now − `date_posted`; sort by waiting time.
6. **Persistence**: Store normalized job records and relevant metadata in the database (deduplication/incremental updates).
7. **User access**: Frontend (Angular) queries REST API → Backend reads from database → Filtered, sorted results returned to UI.

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

## 8. Deliverables / File Plan (High-Level)

| Component | Purpose |
|-----------|---------|
| `backend/` | Node.js + Express app: REST API, source adapters, pipeline, daemon, database models (TBD). |
| `frontend/` | Angular app: web UI for browsing/filtering/sorting jobs. |
| `backend/src/sources/base/JobSource.ts` | Abstract source adapter interface (pluggable). |
| `backend/src/sources/rezi/` | Rezi source adapter (tiles/PMTiles, IDs, details API, normalization). |
| `backend/src/pipeline/` | Normalization, filtering, classification, sorting logic (source-agnostic). |
| `backend/src/daemon/` | Periodic job fetcher for configured sources. |
| `backend/src/db/` | Database layer, migrations, models (TBD; MySQL candidate). |
| `backend/src/api/` | REST API routes/controllers. |
| `docs/` | Documentation (architecture, setup, usage). |
| `PLAN.md` | This document |

---

## 9. Implementation Roadmap (Suggested Order)

| Phase | Task | Description |
|-------|------|-------------|
| 1 | Define backend/frontend structure | Scaffold Node.js + Express backend and Angular frontend. |
| 2 | Define common types/schema | Define normalized `JobRecord` types and `JobSource` adapter interface (technology-agnostic contract). |
| 3 | Implement Rezi source adapter | Port Rezi logic (tiles, PMTiles, IDs, details API) into pluggable adapter with normalization. |
| 4 | Implement core pipeline | Filtering (programming), waiting-time classification, sorting. |
| 5 | Database layer | Set up database (TBD; MySQL candidate), schema/migrations, persistence logic. |
| 6 | Implement daemon | Periodic fetcher to run sources and persist results (incremental/resumable). |
| 7 | Implement REST API | Endpoints to query/filter/sort stored jobs. |
| 8 | Implement Angular frontend | Web UI to browse, filter, and sort programming-related jobs. |
| 9 | Testing | Validate against sample areas; verify filter accuracy and pipeline correctness. |
| 10 | Documentation | Setup, usage, and architecture docs. |

---

## 10. Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| API rate limiting / blocking | Configurable `api_delay`; retry with exponential backoff; process in small batches. |
| PMTiles directory format changes | Use robust parsing (existing `pmtiles` logic); keep source adapter isolated. |
| Missing tiles in directory | Treat missing tiles as empty (no jobs); log count. |
| `date_posted` in the future or missing | Clamp `days_waiting` to ≥0; skip jobs without `date_posted` or mark as unknown. |
| Large areas → many tiles → many API batches | Configurable limits; warn about estimated load; daemon scheduling. |
| Source schema drift across future adapters | Normalized `JobRecord` schema with per-source normalization functions. |
| New sources require different fetch mechanisms (e.g., scraping) | Adapter interface (`JobSource`) isolates source-specific logic from core pipeline. |
| Technology choices TBD (DB/model) | Keep persistence layer abstracted to allow swapping (e.g., MySQL initially). |

---

## 11. Next Step

Scaffold backend (Node.js + Express) and frontend (Angular), define `JobSource` interface and normalized `JobRecord` types, then implement the Rezi source adapter in the backend.