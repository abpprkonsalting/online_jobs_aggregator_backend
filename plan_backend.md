# Backend Implementation Plan

This document details the backend implementation based on the modular architecture defined in `PLAN.md` and the data model in `DATA_MODEL.md`.

---

## 1. Goals
- Implement a base orchestrator (daemon process) that reads global configuration from `.env` on startup, manages source lifecycle, and starts a fetch cycle per active source.
- Use a **pluggable `JobSource` adapter interface** so new sources (API, scraping, hybrid) can be added without modifying core logic.
- Use the **transform ETL engine** from `lmp_scraper` (adapted to our stack) with per-adapter `transform_config` for normalization into the normalized schema.
- Persist normalized job records (jobs, skills, job_skills, locations, cities, countries, categories, job_categories) with provenance and deduplication, driven by the transform engine via `JobRepository`.
- Track fetch runs per source (`fetch_runs`) with status, metrics, acquisition metadata, and errors.
- Respect rate limits, retry/backoff, be resilient to partial failures, and remain source-agnostic.
- Use `.env` for basic working variables; per-source config lives in `sources.config`.

---

## 2. Architecture Overview

```
Backend Daemon (Node.js + Express)
    │
    ├── Orchestrator (RxJS-style: interval, fire & forget)
    │   ├── loads config from .env (exclusively), including enabled sources.
    │   ├── tracks in-flight cycles (heartbeat/stalled detection)
    │   ├── applies concurrency limit (MAX_CONCURRENT_SOURCES)
    │   └── records run state in fetch_runs
    │
    ├── JobSource Adapters (pluggable)
    │   ├── ReziJobSource (API + PMTiles)
    │   └── future sources (scrape, hybrid)
    │
    ├── Transform ETL Engine (adapted from lmp_scraper)
    │   ├── per-adapter transform_config (declarative mapping)
    │   ├── pipeline: map_fields → resolve_relations → validate → deduplicate → persist
    │   └── produces normalized entities, persists via JobRepository
    │
    ├── Persistence (JobRepository)
    │   ├── upsert/sync, diff-based (adopted from lmp_scraper)
    │   └── DB access (MySQL) via DB-agnostic layer
    │
    └── Infra: Logger (multi-driver), RateLimiter (per-source), Config (.env only, bootstrap from sources config if needed)
```

---

## 3. Orchestrator (RxJS-style, Fire & Forget)

The daemon uses a **RxJS-style lifecycle** (following `lmp_scraper`'s approach) adapted to our domain.

### 3.1 Behavior
- **Configuration**: global configuration is read exclusively from `.env` (`config/index.ts`).
- **Poll interval**: computed at startup from source configs as `MIN(source_intervals) / 10` (capped by `POLL_INTERVAL_MS`); ensures no source can miss its scheduled run.
- Polling loop: immediately run on start, then every `POLL_INTERVAL_MS` (interval).
- Fire & forget: cycles do not block the loop; in-flight cycles tracked in memory.
- Concurrency: max concurrent source cycles = `MAX_CONCURRENT_SOURCES` (env).
- Stalled detection: cycles exceeding `FETCH_TIMEOUT_MS` are aborted and marked failed; `STALLED_THRESHOLD_MS` must be >= `FETCH_TIMEOUT_MS` to avoid false stalls.
- Retries: up to `MAX_RETRIES` per cycle (env); fixed `RETRY_DELAY_MS` with preference for exponential backoff on network errors (configurable per-source in `sources.config.retry`).
- Graceful shutdown: on `SIGINT`/`SIGTERM`, stop the loop, await in-flight cycles, call adapter `cleanup()` (if present), close DB/infra.

### 3.2 Execution flow per cycle
1. Load global configuration from `.env` (only).
2. Load enabled source IDs from `ENABLED_SOURCES` env var; fetch full `sources` config rows from the database table. Compute optimal poll interval as `MIN(source_intervals) / 10` (capped by `POLL_INTERVAL_MS` config default) — ensures no source misses its schedule.
3. Load enabled `(source, area)` pairs from `source_geographic_areas` where `enabled = 1`; join with `geographic_areas` for the standardized definition.
4. For each enabled `(source, area)` pair, create `fetch_runs` row: status=`running`, started_at=now. Track source_id and geographic_area_id.
5. Adapter: `adapter.fetch({ geographicArea })` → passes the standardized area definition to the adapter; adapter converts to its native format internally → returns `FetchResult{ rawJobs, metrics(acquisition only), metadata, warnings }` (raw, no normalization).
6. Transform: run transform engine with the adapter's `transform_config` over `rawJobs` → produces normalized entities (jobs, skills, job_skills, locations, cities, countries); persist via `JobRepository` with upsert/sync and dedup by `(source_id, external_id)`.
7. Aggregate: `jobs_found = rawJobs.length`, compute `jobs_saved_new`/`jobs_saved_updated` from transform run; set `jobs.fetched_at` on persisted jobs.
8. Finalize: write `fetch_runs` as `success|failed`, set `finished_at`, store counters, `metadata = { ...adapter.metadata, ...adapter.metrics }`, `warnings = adapter.warnings`, `error_message` if failed; update `sources.last_run_at` and `source_geographic_areas.last_run_at`/`next_run_at`.
9. Continue to other (source, area) pairs on failure (per-pair isolation).

---

## 4. JobSource Adapter Interface (Contract)

Each source implements this contract. The orchestrator interacts only with it.

```ts
export interface GeographicArea {
  id: string;               // geographic_areas.id (UUID)
  name: string;             // Human-readable name
  definition: Record<string, unknown>; // Standard definition {bbox, zoom}
}

export interface FetchRunMetrics {
  jobsFound: number;        // raw records returned (acquisition only)
  [key: string]: unknown;   // source-specific acquisition metrics
}

export interface FetchResult {
  rawJobs: unknown[];        // raw source-native records (each must include raw_data + external_id)
  metrics: FetchRunMetrics;   // acquisition counters
  metadata?: Record<string, unknown>; // source-specific acquisition metadata
  warnings?: string[];       // non-fatal issues
}

export interface SourceConfig {
  id: string;               // sources.id (UUID)
  name: string;             // e.g., rezi-map
  type: 'api' | 'scrape' | 'hybrid';
  config: Record<string, unknown>; // sources.config JSON (rate limits, retry, bbox, etc.)
  enabled: boolean;
  last_run_at?: Date | null;
}

export interface JobSourceContext {
  source: SourceConfig;       // sources row (id, name, type, config, enabled)
  logger: Logger;
  rateLimiter: RateLimiter;   // per-source pacing
  clock: () => Date;          // testable clock
}

export abstract class JobSource {
  constructor(protected ctx: JobSourceContext) {}
  abstract fetch(geographicArea: GeographicArea): Promise<FetchResult>;
  cleanup?(): Promise<void>;
}
```

**Rules:**
- `fetch(geographicArea)` returns raw records. No DB access, no normalization to DB columns.
- Each `rawJobs` item must include `raw_data` (full original record; JSON) and `external_id` (string, source native ID) for dedup/traceability.
- Adapters may keep native fields inside `raw_data`; mapping to normalized columns is declared in `transform_config` (not in the adapter).
- Rate limiting, retries/backoff (per `sources.config`) enforced inside adapter.
- Treat missing/empty resources (e.g., absent tiles) as empty results (no error).
- Provenance (`source_id`) attached by orchestrator.
- Classification into `categories`/`job_categories` is performed by the adapter; the adapter's output must include category assignments that the `transform_config` maps.

---

## 5. Transform ETL Engine (Normalization via `transform_config`)

Normalization is performed by the **transform ETL engine** adapted from `lmp_scraper` (never inline in adapters). This is adopted now for the fetching phase.

> **Reference:** The transform engine is adapted from `lmp_scraper` (external project). `TransformConfig (v3)`, `date_parse`, `entity_lookup_auto`, and `calculateDiff` are `lmp_scraper` concepts being ported to this stack via `JobRepository`. The original code is not part of this repository.

### 5.1 Design
- **Per-adapter `transform_config`** (declarative JSON) declares how raw source records map to `DATA_MODEL.md` entities: `jobs`, `job_skills`, `job_categories`, `locations`. Master tables (`skills`, `categories`, `cities`, `countries`, `geographic_areas`) are **populated from the frontend** and must **not** be created, updated, or deleted by the fetch pipeline.
- **Pipeline (same as lmp_scraper v3):** `map_fields` → `resolve_relations` → `validate` → `deduplicate` → `persist`.
- **Parent/child ordering** and `sourceArray` expansion supported (e.g., `ai_key_skills` as array → resolve against existing `skills` → `job_skills`).
- **Resolvers:** e.g., `entity_lookup` to resolve source-provided values against existing master tables (skills, cities, countries); adapter handles mismatches via config translation or fuzzy matching — the pipeline never auto-creates master data.
- **Persistence:** transform `persist` stage calls `JobRepository`; jobs upsert by `matchBy` (`['source_id','external_id']`); child tables (`job_skills`, `job_categories`, `locations`) upsert/sync per job.
- **Traceability:** `raw_data` preserved end-to-end; transform config is the explicit mapping.

### 5.2 Rezi mapping (to be authored now)

Geographic area conversion: For phase 1, the standard `geographic_areas.definition` (`{bbox, zoom}`) **is** Rezi's native format — no translation needed; the adapter passes the standard through directly to PMTiles tile computation. Other sources will translate the standard definition into their own format.

Job record mapping:
- `external_id` ← `String(obfuscated_id)`
- `jobs`: title, organization, job_url, description_text, `allow_remote` ← `remote_derived`, salary fields (min/max/currency/unit), `date_posted` (original source timestamp, parsed to DATETIME), `posted_at` (derived/computed normalized timestamp)
- `skills` + `job_skills`: from `ai_key_skills` array → resolve against existing `skills` table via adapter-provided translation or fuzzy match (pipeline never auto-creates skills); persisted as `job_skills` (job_id, skill_id)
- `locations`/`cities`/`countries`: from location signals → resolve against existing `cities`/`countries` tables via adapter-provided translation or fuzzy match; `raw_text` stored in `locations`
- `raw_data` kept for every job

### 5.3 Engine adaptations (required)
- Replace Supabase persistence with `JobRepository` (DB-agnostic SQL; MySQL candidate).
- Replace Supabase RPCs with repository methods (`upsert`, `sync`, `find`, etc.).
- Adopt the `TransformConfig` (v3) schema for the mapping contract; persistence signatures adjusted to our DB layer.
- `calculateDiff`/`sync` inherited (logic) and ported.

---

## 6. Persistence: `JobRepository`

All persistence flows through `JobRepository` (adopted from `lmp_scraper` persistence strategies, adapted to our stack).

- **upsert(table, rows, matchBy, options)** — insert-or-update by `matchBy`; used for jobs and idempotent re-runs.
- **sync(table, rows, matchBy, options)** — read existing, `calculateDiff`, delete orphans, upsert inserts/updates; **only used for per-job child tables** (`job_skills`, `job_categories`, `locations`) where the child set must exactly reflect the current fetch. **Master tables** (`skills`, `categories`, `cities`, `countries`, `geographic_areas`) are **never synced or deleted**; they are managed exclusively from the frontend.
- **calculateDiff** — keyed by `keyFields`, returns `toInsert/toUpdate/toDelete/unchanged`; used for accurate counters.
- **fetch_runs** operations: create/update status/timestamps/counters/metadata/error_message; update `sources.last_run_at` and `source_geographic_areas.last_run_at`/`next_run_at`.
- **counter aggregation**: `jobs_saved_new`/`jobs_saved_updated` come from transform run result (via upsert/sync outcomes).
- **area fetch state**: update `source_geographic_areas.last_run_at`/`next_run_at` per (source, area) pair.

---

## 7. Configuration & `.env`

Global settings via `.env` (env-first), loaded by `backend/src/config/index.ts`. Per-source config lives in the database `sources.config` column (see `DATA_MODEL.md` §1); `sources.config` in code references the DB column, not a file. `SOURCES_CONFIG_PATH` is only a bootstrap/fallback when the DB table is unavailable.

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | Runtime mode |
| `PORT` | `3000` | Express API port |
| `DATABASE_URL` | _(required)_ | DB connection string (MySQL candidate) |
| `DB_DIALECT` | `mysql` | DB dialect |
| `SOURCES_CONFIG_PATH` | `./config/sources.json` | Fallback source config file (used only if DB `sources` table is empty/unavailable) |
| `ENABLED_SOURCES` | `` | Comma-separated list of source IDs that are enabled (e.g., `rezi-map`). All other source configuration comes from the database `sources` table. |
| `POLL_INTERVAL_MS` | `5000` | Global poll interval. Computed at startup as `MIN(source interval_ms) / 10`, capped by this default. Ensures no source can miss its scheduled run. |
| `MAX_CONCURRENT_SOURCES` | `3` | Max concurrent source cycles |
| `MAX_RETRIES` | `3` | Max attempts per cycle |
| `RETRY_DELAY_MS` | `60000` | Delay between retries (fixed; exponential preferred for network errors) |
| `API_TIMEOUT_MS` | `30000` | Default HTTP timeout for adapters |
| `LOG_LEVEL` | `info` | Minimum log level |
| `LOG_DIR` | `./logs` | Local log directory |
| `LOGGERS` | `["console","local"]` | Active log drivers (`console`, `local`, `db`) |
| `CACHE_DIR` | `./cache` | Adapter/cache directory |
| `FETCH_TIMEOUT_MS` | `1800000` | Wall-clock cap per cycle (30m) |
| `STALLED_THRESHOLD_MS` | `3600000` | Heartbeat staleness threshold (1h); must be >= `FETCH_TIMEOUT_MS` |

---

## 8. Deliverables (Files)

| File | Purpose |
|---|---|
| `backend/src/orchestrator/JobOrchestrator.ts` | RxJS-style daemon loop, fire & forget, stalled detection, graceful shutdown |
| `backend/src/sources/base/JobSource.ts` | Adapter interface, types (`FetchResult`, `FetchRunMetrics`, context) |
| `backend/src/sources/base/JobSourceFactory.ts` | Factory mapping source type/name → concrete adapter |
| `backend/src/sources/rezi/ReziJobSource.ts` | Rezi adapter (PMTiles + details API, raw payload + `raw_data`) |
| `backend/src/sources/rezi/pmtiles.ts` | PMTiles parsing/utilities (header/directory, ranges, gzip) |
| `backend/src/transform/` | Adapted transform ETL engine wired to `JobRepository`; per-adapter `transform_config` (Rezi) |
| `backend/src/transform/rezi.transform.json` | Rezi per-adapter transform_config mapping declaration |
| `backend/src/persistence/JobRepository.ts` | DB abstraction: upsert/sync/diff, fetch_runs operations |
| `backend/src/config/index.ts` | Env-first config (`CONFIG`) with defaults + bootstrap |
| `backend/src/utils/logger.ts` | Multi-driver logger |
| `backend/src/utils/rate-limiter.ts` | Per-source pacing helper |
| `backend/src/types/normalized.ts` | Normalized types aligned with `DATA_MODEL.md` |
| `backend/src/config/sourceLoader.ts` | Source loading (DB/fallback) |
| `backend/src/daemon/index.ts` | Daemon entrypoint |
| `backend/.env` / `backend/.env.example` | Environment variables |
| `plan_backend.md` | This document |

---

## 9. Implementation Notes (Alignment with PLAN.md)

- **FR-01:** pluggable `JobSource` adapters, source-agnostic core.
- **FR-02:** normalized persistence with provenance (`source_id`, `external_id`), dedup via upsert/sync, `raw_data` preserved.
- **FR-10:** configurable sources via `sources.config` + env-first globals.
- **FR-11:** `fetch_runs` with status, timestamps, counters, `metadata`, `error_message`.
- **NF-01/NF-02:** core agnostic; normalization via transform engine + per-adapter `transform_config`; classification is adapter-specific.
- **Retries/backoff:** execution-level retries per `MAX_RETRIES`/`RETRY_DELAY_MS`; per-source `api_delay` and `retry` config in `sources.config`.
- **PMTiles:** missing tiles treated as empty; `max_tiles` safety cap (per-source config, not global `.env`); gzip decompression; range requests.
- **Concurrency/stalled:** `MAX_CONCURRENT_SOURCES` concurrency cap; stalled detection uses `FETCH_TIMEOUT_MS`/`STALLED_THRESHOLD_MS`; poll interval computed at startup guarantees no source misses its schedule.

---

## 10. Testing & Validation

- **Adapter:** PMTiles parsing, tile→IDs, batching (<=9), raw payload includes `raw_data` + `external_id`.
- **Transform:** Rezi `transform_config` maps raw records to normalized entities (jobs, skills, job_skills, locations, cities, countries); upsert by `(source_id,external_id)` works across runs; skills/locations created/linked correctly.
- **Persistence:** `upsert`/`sync` + `calculateDiff` give correct `jobs_saved_new`/`jobs_saved_updated`; orphans handled by sync.
- **Orchestrator:** polling loop, fire & forget, concurrency cap, stalled detection, graceful shutdown.
- **Resilience:** missing tiles empty; batch failure logged with warnings, cycle continues; retries/backoff respected.
- **Metrics:** `fetch_runs.metadata` = acquisition metrics; counters accurate.

---

## 11. Next Steps

1. Define types: `JobSource`, `FetchResult`, `FetchRunMetrics`, context, source config.
2. Scaffold orchestrator + `JobRepository` + config + logger + rate limiter.
3. Adapt the `lmp_scraper` transform ETL engine to `JobRepository` (replace Supabase persistence).
4. Author Rezi `transform_config` (jobs, skills, job_skills, locations, cities, countries) per §5.2.
5. Implement `ReziJobSource` + PMTiles utilities (raw payload only).
6. Wire daemon entrypoint and bootstrap (DB/fallback).
7. Run fetching cycle against Rezi (small bbox), validate dedup + normalized persistence + `fetch_runs` metadata.
8. Add per-source `retry`/pacing, finalize graceful shutdown, and prepare for future sources.
