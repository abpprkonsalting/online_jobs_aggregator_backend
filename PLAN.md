# Project Development Plan: Job Extraction Platform

## 1. Problem Statement

We need a job-extraction platform. The design must be **modular** and **technology-agnostic**, prepared for different data sources, some of which may require web scraping, different API protocols, or other delivery mechanisms. New sources must be able to be added without modifying core logic.

The first phase will be:
1. Extract job postings from `https://map.rezi.ai/` filtered by geographic location — using the open, unauthenticated API endpoints already discovered.
2. Identify and classify job postings into relevant categories.
3. Classify jobs by **how long they have been waiting to be filled** (based on `posted_at`/`date_posted`).
4. Present the results as a **sorted, filterable list** for review and downstream use.

---

## 2. Current State / Knowns

### 2.1 Data sources (first source)

The first source is the Rezi map endpoint. Two endpoints are confirmed via HAR inspection:

| Endpoint | Method | Auth | Notes |
|----------|--------|------|-------|
| `https://maps-cdn.rezi.ai/jobs/jobs_v2.pmtiles` | GET (Range) | None | PMTiles v3 spatial index; each tile contains varint-encoded `obfuscated_id` values for jobs in that tile's geographic area. Total file ~775 MB; we fetch only tile byte ranges covering the target area. |
| `https://api.rezi.ai/v1/search-engine/maps/jobs/details?page=1&rows_per_page=9` | POST | None | Accepts JSON body `{"obfuscated_ids":[...]}` (observed max 9 IDs per call). Returns full job records. |

### 2.2 Geographic areas

Geographic areas are stored centrally in the `geographic_areas` table (see `DATA_MODEL.md` §2). For phase 1, the standard definition **is** Rezi's native format: a bounding box (`bbox: [min_lon, min_lat, max_lon, max_lat]`) plus a `zoom` level, used directly to compute PMTiles tile coordinates. No translation is needed for the first source. Other sources will translate the standard definition into their own format.

The `source_geographic_areas` many-to-many table (§3) links each source to the areas it should fetch, with an `enabled` flag. This keeps the source URL/config singular — one source row, many areas — avoiding duplication of sources per area.

### 2.3 Job record fields (from `output.json` / `jobs_output.json`)

Current Rezi source fields (these are mapped by the adapter into the normalized model defined in `DATA_MODEL.md`):

- `obfuscated_id` (int) — source native ID
- `title` (string), `organization` (string), `job_url` (string), `description_text` (string)
- `date_posted` (ISO-8601 string) — original posted date
- `locations_derived`, `cities_derived`, `countries_derived` — mapped to normalized locations/cities/countries
- `remote_derived` (boolean) — mapped to `allow_remote`
- `salary_min_value`, `salary_max_value`, `salary_currency`, `salary_unit_text` — mapped to normalized salary fields
- `ai_key_skills` (array of strings) — mapped to normalized `skills` (many-to-many)
- Other fields (e.g., `frontend_payload`, `employment_type`, `experience_level`, `work_arrangement`) may be used by the adapter for normalization/classification and stored as needed in `raw_data`.

### 2.4 Technical constraints & observations

- No authentication required on the first source endpoints.
- Details API accepts ~9 `obfuscated_ids` per POST call (observed).
- PMTiles file is ~775 MB; only tile ranges covering the user's bounding box should be downloaded.
- Tiles not present in the directory are empty (no jobs in that area).
- Tile compression is GZIP (PMTiles v3).
- `date_posted` values are in the past (e.g., July 2026); waiting time is computed from `posted_at`/`date_posted`.
- Per-source fetch intervals are defined in `sources.config.interval_ms` (ms) or `cron` expression; the daemon uses an adaptive global tick computed from the shortest source interval.

---

## 3. Requirements

### 3.1 Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-01 | Support pluggable job sources via a common Source Adapter interface (API, scraping, hybrid) so sources can be added/removed without modifying core pipeline logic. | High |
| FR-02 | Persist jobs in normalized form per `DATA_MODEL.md` with provenance (source, external_id) and deduplication. | High |
| FR-03 | Backend daemon to periodically query enabled sources and update stored job data. | High |
| FR-04 | Provide a REST API and a web interface (Angular) to query, filter, and sort jobs. | High |
| FR-05 | Classify jobs into categories (many-to-many) with per-assignment confidence. | High |
| FR-06 | Normalize skills into a `skills` table with many-to-many mapping (`job_skills`). | High |
| FR-07 | Normalize locations into `countries`, `cities`, and `locations` tables from source-provided location data. | High |
| FR-08 | Compute waiting time (days since posted) from `posted_at` or `date_posted` and allow sorting by waiting time (oldest first). | High |
| FR-09 | Support filtering by categories, skills, location/country/city, remote availability (`allow_remote`), salary range, and organization. | Medium |
| FR-10 | Allow configuration of sources (name, type, enabled, config) in a generic way. | Medium |
| FR-11 | Track fetch runs per source with status, timestamps, and generic metadata (`metadata` JSON). | Medium |
| FR-12 | Apply respectful rate limiting per source with retry/backoff where applicable. | Medium |
| FR-13 | Retain provenance/traceability (store `raw_data` and source association) for processed jobs. | Medium |
| FR-14 | User authentication (login/refresh/logout) with role-based access control (`admin`, `user`). | Medium |
| FR-15 | Admin endpoints to manage sources, geographic areas, master table seed, and fetch runs. | Medium |

### 3.2 Non-Functional Requirements

| ID | Requirement |
|----|-------------|
| NF-01 | Architecture must support multiple source types (API-based, scraping-based, hybrid) via a common adapter interface. |
| NF-02 | Core pipeline (classification, normalization, processing logic) must operate on a normalized schema independent of the source, following `DATA_MODEL.md`. |
| NF-03 | Respectful rate limiting to avoid overwhelming any API or server. |
| NF-04 | Backend: Node.js with Express. Frontend (first version): Angular. |
| NF-05 | Database: to be determined later (with MySQL as a strong candidate). |
| NF-06 | Data model: as defined in `DATA_MODEL.md`. |
| NF-07 | Deterministic and traceable processing. |

---

## 4. System Architecture (High-Level)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Frontend (Angular)                              │
│                     Web UI for browsing, filtering, sorting                │
│                         Job listings (filterable by categories, skills, location, etc.)                 │
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
│  │                                        │                                    │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                           Auth Layer (JWT)                           │   │
│  │  POST /api/auth/login, /api/auth/refresh, /api/auth/logout            │   │
│  │  GET /api/auth/me, user CRUD (admin only)                            │   │
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

- Web interface to view, filter, and sort jobs by categories, waiting time, location, remote availability, salary range, etc.
- Communicates with the backend via REST API.

**Backend (Node.js + Express):**

- **REST API Layer**: Exposes endpoints to query, filter, and sort jobs stored in the database.
- **Source Adapters (pluggable)**: Modular adapters implementing a common interface (`JobSource`). Each adapter encapsulates source-specific logic (API calls, scraping, etc.). First adapter: Rezi map.
  - `sources/base/JobSource` (interface/contract)
  - `sources/rezi/` — Rezi implementation (tiles/PMTiles parsing, ID extraction, details API, normalization, classification)
- **Classification (adapter-specific)**: Each `JobSource` adapter classifies jobs into categories (`categories`/`job_categories` with confidence) using its own internal method. The adapter's output includes category assignments.
- **Job Fetcher Daemon**: Background process that periodically runs configured source adapters, persists normalized job records to the database. Handles deduplication and incremental updates per source. **Does not manage master tables** (`skills`, `categories`, `cities`, `countries`, `geographic_areas`); these are populated exclusively via the frontend or admin interfaces.
- **Database Layer**: Persistence for jobs, sources, fetch runs, locations, categories, skills, etc. as defined in `DATA_MODEL.md`. Database and schema are TBD (MySQL candidate).

---

## 5. Data Flow

1. **Configuration:** Sources, enabled sources, and the (source, area) fetch matrix configured via database tables — `sources` (§1), `geographic_areas` (§2), and `source_geographic_areas` (§3). Per-source schedule (`interval_ms` or `cron`) stored in `sources.config`; computed per (source,area) pair also stored in `source_geographic_areas.next_run_at`.
2. **Periodic fetch (daemon):** Daemon triggers enabled `(source, area)` pairs; checks each `source_geographic_areas` row's `next_run_at` before firing.
3. **Rezi source (first source) — per geographic area:**
   a. Bbox/region → tile computation: Bbox + zoom → list of (z, x, y) tiles
   b. Offset resolution: Tile list + PMTiles directory → list of (tile_offset, tile_length)
   c. Tile fetch: Range requests → gzip-decompressed tile bytes
   d. ID extraction: Tile bytes → set of `obfuscated_id` ints
   e. API batching: ID set → batches of 9 → POST requests → raw job records
4. **Normalization:** Raw job records → normalized schema (per `DATA_MODEL.md`) via transform engine / source-specific normalizer.
5. **Classification** (adapter-specific): Each adapter assigns categories (many-to-many) with confidence via its own internal method.
6. **Persistence:** Store normalized job records and relevant metadata in the database (deduplication/incremental updates), setting `jobs.fetched_at`.
7. **User access:** Frontend (Angular) queries REST API → Backend reads from database → Filtered, sorted results returned to UI.

---

## 6. Classification Logic (FR-05)

Classification is performed by the source adapters (not a shared core pipeline) into categories (many-to-many). Each adapter has its own internal classification method. For the first phase, the Rezi adapter uses normalized `skills` (mapped from `ai_key_skills`), `title`, and `description_text` to determine category relevance and assign per-assignment confidence.

---

## 7. Waiting Time Calculation (FR-08)

- `days_waiting` = `(current_utc_date − posted_at/date_posted).days`
- Categories (optional labels):
  - `fresh`: 0–7 days
  - `recent`: 8–30 days
  - `aging`: 31–60 days
  - `stale`: 61–90 days
  - `stalled`: 90+ days
- Sort order: `days_waiting` descending (oldest postings first)

**Note:** Waiting time is computed at query time in the REST API layer (not during fetch/persistence). The daemon stores `posted_at`/`date_posted` only; sorting and `days_waiting` calculation happen when the API serves filtered/sorted job listings.

---

## 8. Deliverables / File Plan (High-Level)

| Component | Purpose |
|-----------|---------|
| `backend/` | Node.js + Express app: source adapters, daemon, database models (TBD). |
| `frontend/` | Angular app: web UI for browsing/filtering/sorting jobs. |
| `backend/src/sources/base/JobSource.ts` | Abstract source adapter interface (pluggable). |
| `backend/src/sources/rezi/` | Rezi source adapter (tiles/PMTiles, IDs, details API, normalization, classification). |
| `backend/src/api/auth.ts` | Auth routes (login, refresh, logout, me). |
| `backend/src/api/users.ts` | User management routes (CRUD, admin only). |
| `backend/src/api/jobs.ts` | Job list/detail endpoints. |
| `backend/src/api/master.ts` | Master table seed/snapshot endpoints. |
| `backend/src/api/admin.ts` | Admin endpoints (sources, areas, fetch_runs, trigger). |
| `backend/src/middleware/auth.ts` | JWT middleware + role-based authorization (`requireAuth`, `requireRole`). |
| `backend/src/utils/auth.ts` | Token sign/verify, bcrypt hash/verify helpers. |
| `backend/src/pipeline/` | N/A — classification is adapter-specific; handled within each `JobSource` adapter. |
| `backend/src/daemon/` | Periodic job fetcher for configured sources. |
| `backend/src/db/` | Database layer, migrations, models (based on `DATA_MODEL.md`; MySQL candidate). |
| `backend/src/api/` | REST API routes/controllers. |
| `docs/` | Documentation (architecture, setup, usage). |
| `PLAN.md` | This document |

---

## 9. Implementation Roadmap (Suggested Order)

| Phase | Task | Description |
|-------|------|-------------|
| 1 | Define backend/frontend structure | Scaffold Node.js + Express backend and Angular frontend. |
| 2 | Define common types/schema | Define normalized types based on `DATA_MODEL.md` and `JobSource` adapter interface (technology-agnostic contract). |
| 3 | Implement Auth layer | JWT login/refresh/logout, bcrypt password hashing, role middleware, seed admin user. |
| 4 | Implement Rezi source adapter | Port Rezi logic (tiles, PMTiles, IDs, details API) into pluggable adapter with normalization, classification, and per-source schedule (`interval_ms` in `sources.config`). |
| 5 | Database layer | Set up database (TBD; MySQL candidate), schema/migrations, persistence logic; include `next_run_at` in `sources` table. |
| 6 | Implement daemon | Periodic fetcher to run sources and persist results with deduplication/incremental updates. Compute adaptive global poll interval from source configs at startup. |
| 7 | Implement REST API | Job query endpoints, admin CRUD, master seed, auth endpoints. |
| 8 | Implement Angular frontend | Web UI to browse, filter, and sort jobs by categories, skills, location, etc. |
| 9 | Testing | Validate with Rezi source and verify classification, filtering, sorting, and deduplication. |
| 10 | Documentation | Setup, usage, and architecture docs. |

---

## 10. Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| API rate limiting / blocking | Configurable `api_delay`; retry with exponential backoff; process in small batches. |
| PMTiles directory format changes | Use robust parsing (existing `pmtiles` logic); keep source adapter isolated. |
| Missing tiles in directory | Treat missing tiles as empty (no jobs); log count. |
| `date_posted`/`posted_at` missing or invalid | Compute days from available timestamp (prefer `posted_at`); skip or mark if neither is valid. |
| Large areas → many tiles → many API batches | Configurable limits; warn about estimated load; daemon scheduling. |
| Source schema drift across future adapters | Follow `DATA_MODEL.md`; per-source normalization maps to the fixed normalized schema. |
| New sources require different fetch mechanisms (e.g., scraping) | Adapter interface (`JobSource`) isolates source-specific logic from core pipeline. |
| Technology choices TBD (DB/model) | Keep persistence layer abstracted to allow swapping (e.g., MySQL initially). |
| Auth token theft / session fixation | HttpOnly cookies + short access token TTL; refresh token rotation with revocation; bcrypt-hashed refresh tokens in DB. |

---

## 11. Next Step

See `plan_backend.md` for the backend implementation plan (orchestrator, `JobSource` adapter interface, Rezi adapter, persistence, daemon flow, and auth layer). This document covers the full backend scope — fetching, persistence, normalization, daemon flow, and user authentication. Classification is adapter-specific and deferred to future phases. `plan_backend.md` does not include REST API endpoints or an Angular frontend; those are tracked in later roadmap phases. Scaffold the backend (Node.js + Express) following that plan, then implement the Rezi source adapter in the backend.