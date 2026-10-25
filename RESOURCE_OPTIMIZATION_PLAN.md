# Backend resource optimization plan

## Purpose and scope

Reduce the fetcher's CPU, memory, disk-I/O, and database load on the VPS without
silently losing fetched jobs or making the API unresponsive. Apply the
serialized scheduling and repository optimizations first; a real database
adapter/repository boundary comes in Phase 5 so any future driver swap is a
driver-implementation task, not a rewrite of every SQL string.

This is an implementation plan, not a code change. Changes should be small, reversible, and tested against fetched data and API behavior. Work items are intentionally small enough to review and commit independently. Use the suggested commit scope as a guide; a single work item may take more than one commit, but avoid combining unrelated items. Check an item off only after its acceptance check passes.

## Source documentation and decisions

This plan follows:

- `src/orchestrator/JobOrchestrator.ts`: orchestrator start/stop, passive and proactive cycles, running-cycles guard, semaphore concurrency.
- `src/config/index.ts`: `POLL_INTERVAL_MS`, `MAX_CONCURRENT_SOURCES`, `DB_DIALECT`.
- `src/persistence/JobRepository.ts`: `upsertJob`, sync functions (`syncJobSkills`, `syncJobCategories`, `syncLocations`), `findJobs`, `listFetchRuns`, pool-bound repository methods.
- `src/transform/engine.ts`: per-job processing loop, `upsertJob` calls, child-entity sync, resolver creation per run.
- `src/transform/resolver.ts`: full-list reads on cache miss, per-run cache scope, entity creation.
- `src/api/jobs.ts`: `findJobs()` → `SELECT * FROM jobs`, in-memory filter/sort/paginate, placeholder category/skill/city/country filters.
- `src/database/db.ts`: `connectionLimit: 10` per process, MySQL-only.
- `src/database/migrations.ts`: MySQL-specific DDL (`ENUM`, `ON DUPLICATE KEY UPDATE`, `information_schema`).
- `src/utils/rate-limiter.ts`: `TokenBucketRateLimiter` (capacity 10, burstable) and `FixedDelayRateLimiter`.
- `src/sources/rezi/ReziJobSource.ts`: PMTiles fetch, details API pagination, per-keyword search loop.
- `tests/orchestrator/JobOrchestrator.test.ts`, `tests/persistence/JobRepository.test.ts`, `tests/transform/engine.test.ts`, `tests/transform/resolver.test.ts`, `tests/utils/rate-limiter.test.ts`: existing vitest suites to extend.
- `systemd/map-rezi-fetcher.service` and `systemd/map-rezi-api.service`: separate processes sharing one MySQL pool per process.

## Product areas

### Fetcher scheduling (backend)

- One active fetch at a time; no overlapping passive or proactive cycles.
- Round-robin rotation across `(source, area)` pairs and proactive keyword batches.
- Failure backoff and `Retry-After` honoring without blocking other eligible items.
- Graceful shutdown that awaits in-flight work.

### Upstream request throttling (backend)

- Rate-limiter acquisitions serialized; no initial burst bypass.
- `Retry-After` on `429`, bounded backoff for transient failures.
- Bounded pages, IDs, and tile work per cycle with explicit partial results.
- Per-cycle upstream request and response counts exposed.

### Transform and database writes (backend)

- Content-hash based no-op detection for unchanged jobs.
- Batched entity lookups per transform batch (eliminates repeated full-list reads).
- Batched insert/update with accurate new-vs-updated counts.
- Parameterized child-table reconciliation (fixes SQL injection in sync functions).
- Bounded transactions with deadlock retry cap.

### API and indexes (backend)

- Filtering, sort, limit, offset pushed into MySQL via parameterized queries.
- Placeholder category/skill/city/country filters implemented as indexed joins.
- Capped fetch-run history; field projection instead of `SELECT *`.
- Index audit driven by query plans; configurable pool budget across processes.

## Implementation phases

Work items follow a feature → test → acceptance → commit cycle within each item.

## Release types by phase and task

Every work item carries a conventional-commit type that `npm run release:plan` uses to propose the next version:

- `feat(scope): …` → **minor** bump (new behavior, backward compatible)
- `fix(scope): …` → **patch** bump (bug fix, backward compatible)
- `refactor(scope): …` → **no bump** (internal change, no behavior change)
- `test(scope): …` → **no bump** (tests only)
- `perf(scope): …` → **no bump** (performance only)
- `BREAKING CHANGE:` footer → **major** bump (removes or changes a documented contract)

| Phase | Overall release type | Notes |
|-------|----------------------|-------|
| Phase 1 — Serialized scheduler | **minor** | Driven by `feat` commits; `BO1.4` keeps `MAX_CONCURRENT_SOURCES` accepted-but-ignored to avoid a major breaking change |
| Phase 2 — Upstream throttle | **minor** | Driven by `feat` commits; `BO2.1` is a `fix` patch |
| Phase 3 — Redundant transform and write work | **minor** | Driven by `feat` commits; `BO3.4` is a `fix` patch (SQL injection) |
| Phase 4 — SQL filtering and indexes | **minor** | Driven by `feat` commits; `BO4.3` and `BO4.5` are `refactor`/`perf` with no bump |
| Phase 5 — Database adapter boundary | **none / patch** | Pure `refactor` and `test`; no bump unless `feat` for a working `DB_DIALECT` swap |

Per-task release types are annotated on each work item below.

## Branch strategy

Each phase is developed on its own feature branch created from `master`. Only merge to `master` after the phase's exit criteria are met and all acceptance checks pass.

| Phase | Branch name |
|-------|-------------|
| Phase 1 — Serialize work and rotate through work items | `feature/backend-phase-1-serialized-scheduler` |
| Phase 2 — Throttle upstream requests and bound fetch work | `feature/backend-phase-2-upstream-throttle` |
| Phase 3 — Reduce redundant transform and write work | `feature/backend-phase-3-redundant-writes` |
| Phase 4 — Move filtering and pagination into MySQL; audit indexes | `feature/backend-phase-4-sql-filtering-indexes` |
| Phase 5 — Define a real database adapter/repository boundary | `feature/backend-phase-5-database-adapter-boundary` |

Workflow per phase:

1. Create the phase branch from `master`.
2. Implement work items following feature → test → acceptance → commit.
3. When all items are complete and the phase's exit criteria pass, merge the branch to `master`.
4. Start the next phase from the updated `master`.

Never merge an incomplete phase to `master`, and never combine work from two phases on the same branch.

### Phase 1 — Serialize work and rotate through work items

Highest priority; likely to reduce repeated work without changing the transform output.

- [x] **BO1.1 — Replace the async `setInterval` callback with a serialized scheduler.** At every `POLL_INTERVAL_MS` tick, if idle, select and start exactly one work item; otherwise skip that tick. Never overlap fetches, queue missed ticks, or run catch-up work.  
  **Release type:** `feat(backend):` → **minor**  
  **Accept when:** a fake-timer test shows one fetch starts per tick while busy, skipped ticks are not queued, and no two fetches run concurrently.  
  **Commit scope:** `feat(backend): serialize orchestrator scheduler`
- [x] **BO1.2 — Define work items and round-robin rotation.** A work item is one passive `(source, geographic area)` pair or one proactive search batch for a source. Rotate fairly across all eligible items (e.g. `rezi-ga1 → rezi-ga2 → rezi-ga3 → second_source keyword batch → repeat`).  
  **Release type:** `feat(backend):` → **minor**  
  **Accept when:** a test with mixed passive and proactive items verifies deterministic rotation order and fairness when items are added or removed.  
  **Commit scope:** `feat(backend): add round-robin work-item rotation`
- [x] **BO1.3 — Fix the proactive duplicate guard.** `runProactiveSourceCycle` checks `runningCycles` but never registers or removes its own key. Register the proactive key before starting and remove it in a `finally`, matching `runPairCycle`.  
  **Release type:** `fix(backend):` → **patch**  
  **Accept when:** overlapping poll callbacks cannot start duplicate proactive work for the same source.  
  **Commit scope:** `fix(backend): register proactive cycle key in runningCycles`
- [x] **BO1.4 — Remove the semaphore; keep `MAX_CONCURRENT_SOURCES` accepted-but-ignored.** Once passive and proactive work both use the one-at-a-time dispatcher, the semaphore is unnecessary. `MAX_CONCURRENT_SOURCES` remains a documented env var (in `.env.example` and `USER_MANUAL.md`), so it is still accepted and logged as deprecated but no longer affects concurrency. Track the active item for duplicate prevention and graceful shutdown.  
  **Release type:** `refactor(backend):` → **no bump** (if removed entirely it would be `BREAKING CHANGE:` → **major**)  
  **Accept when:** the semaphore class is removed; `MAX_CONCURRENT_SOURCES` is still read but ignored with a deprecation log; shutdown awaits the single active item.  
  **Commit scope:** `refactor(backend): remove MAX_CONCURRENT_SOURCES semaphore, deprecate env var`
- [x] **BO1.5 — Add bounded exponential backoff with jitter and `Retry-After` handling.** Defer only failed items; persist deferral only if it must survive daemon restarts. Honor upstream `Retry-After` responses without blocking other eligible items.  
  **Release type:** `feat(backend):` → **minor**  
  **Accept when:** a failed item backs off with jitter, a `Retry-After` response delays that item only, and other items continue.  
  **Commit scope:** `feat(backend): add failure backoff and Retry-After handling`
- [x] **BO1.6 — Add orchestrator tests.** Cover mixed passive/proactive round-robin order, one active fetch, skipped ticks with no catch-up, failure deferral, changing eligible items, fairness, and shutdown while work is in flight.  
  **Release type:** `test(backend):` → **no bump**  
  **Accept when:** all new tests pass in `tests/orchestrator/JobOrchestrator.test.ts`.  
  **Commit scope:** `test(backend): cover serialized scheduler behavior`

**Phase exit criteria:** no overlapping source-area or proactive cycles; one active fetch at a time; fair rotation; failure items deferred without blocking others.

### Phase 2 — Throttle upstream requests and bound fetch work

- [x] **BO2.1 — Make rate limiting serialize acquisitions.** The `TokenBucketRateLimiter` default permits an initial burst of ten requests. Serialize acquisitions so concurrent adapter calls cannot exceed the intended request rate.  
  **Release type:** `fix(backend):` → **patch**  
  **Accept when:** concurrent `acquire()` calls are spaced by the configured rate and never exceed one request per refill interval.  
  **Commit scope:** `fix(backend): serialize rate-limiter acquisitions`
- [x] **BO2.2 — Configure a nonzero Rezi `api_delay` after measuring cadence.** Measure current request cadence, then set `api_delay` in source config so the fixed-delay limiter paces requests.  
  **Release type:** `feat(backend):` → **minor**  
  **Accept when:** production logs show upstream requests spaced by the configured `api_delay`.  
  **Commit scope:** `feat(backend): configure measured Rezi api_delay`
- [x] **BO2.3 — Honor `Retry-After` on `429` and bound transient backoff.** On `429`, wait the `Retry-After` duration; on other transient failures, use bounded exponential backoff with a strict retry cap. Avoid retrying the whole area when only a details page failed if the adapter can safely resume that page.  
  **Release type:** `feat(backend):` → **minor**  
  **Accept when:** a `429` with `Retry-After` delays only the affected request, and transient failures stop after the retry cap.  
  **Commit scope:** `feat(backend): honor Retry-After and bounded backoff`
- [x] **BO2.4 — Bound pages, IDs, and tile work per cycle.** Cap pages, IDs, and tile work per cycle and make the partial result explicit in metadata/warnings. Keep caps high enough not to silently truncate valid coverage.  
  **Release type:** `feat(backend):` → **minor**  
  **Accept when:** a cycle with more IDs than the cap returns a bounded result set with a warning, and coverage loss is visible in metadata.  
  **Commit scope:** `feat(backend): bound per-cycle fetch work`
- [x] **BO2.5 — Preserve deduplication and expose upstream counts.** Keep ID and job deduplication; expose per-cycle upstream request and response counts in fetch-run metadata.  
  **Release type:** `feat(backend):` → **minor**  
  **Accept when:** fetch-run metadata includes request/response counts and duplicate IDs are not re-fetched within a cycle.  
  **Commit scope:** `feat(backend): expose upstream request counts`
- [x] **BO2.6 — Add rate-limiter and throttling tests.** Deterministic tests using fake timers for spacing, burst limits, concurrent callers, `429`, and configured caps.  
  **Release type:** `test(backend):` → **no bump**  
  **Accept when:** all new tests pass in `tests/utils/rate-limiter.test.ts` and `tests/sources/rezi/ReziJobSource.test.ts`.  
  **Commit scope:** `test(backend): cover rate limiting and fetch bounds`

**Phase exit criteria:** upstream request rate bounded; `429` and transient failures handled; partial results explicit; no silent truncation.

### Phase 3 — Reduce redundant transform and write work

- [x] **BO3.1 — Add `content_hash` column to the `jobs` table.** Add a `content_hash CHAR(64)` column (SHA-256 of stable business fields) via migration.  
  **Release type:** `feat(backend):` → **minor**  
  **Accept when:** the migration applies cleanly, existing rows get a null hash, and new inserts can store a hash.  
  **Commit scope:** `feat(backend): add content_hash to jobs table`
- [x] **BO3.2 — Implement content-hash no-op detection.** Compute a hash over stable business fields (`title`, `organization`, `job_url`, `description_text`, salary fields, `date_posted`, `allow_remote`, resolved category/skill/location associations when relevant). Exclude volatile/computed fields (`fetched_at`, `updated_at`, `created_at`, `raw_data`, derived `time_since_posted`). On first acquisition store the hash; on later passes compare and skip unchanged jobs (do not update `updated_at`, do not count as changed). Define `fetched_at` as last observed and `updated_at` as last content change. Note: `date_posted` is a real content field — if the source reposts with a new date, the hash changes and the update is correct.  
  **Release type:** `feat(backend):` → **minor**  
  **Accept when:** re-fetching an unchanged job performs no `UPDATE` and increments no `jobsSavedUpdated` counter; changing a business field updates the row and hash.  
  **Commit scope:** `feat(backend): skip unchanged jobs via content hash`
- [x] **BO3.3 — Batch entity lookups in the transform.** `src/transform/resolver.ts` loads complete skills/categories/cities/countries lists on every cache miss, and `src/transform/engine.ts:70` creates a fresh `EntityResolver` with an empty cache per run, so unmatched or differently formatted values cause repeated full-list reads. Load lookup tables once per transform batch into normalized maps, resolve all unique names in memory first, batch-insert missing lookup entities and return their IDs, and normalize keys consistently (trim/case/slug). Preserve existing matching behavior where product semantics require it.  
  **Release type:** `feat(backend):` → **minor**  
  **Accept when:** a transform batch of 900 jobs issues a bounded number of lookup reads (one per entity type) regardless of how many duplicate or unmatched names appear; newly created entities are returned with stable IDs usable by child-table sync.  
  **Interaction with content-hash no-op detection:** unchanged jobs skipped by BO3.2 do not trigger entity lookups or creation; only new or changed jobs resolve skills/categories/cities, so entity creation is correctly scoped to jobs whose content actually differs.  
  **Commit scope:** `feat(backend): batch entity lookups per transform batch`
- [x] **BO3.4 — Fix SQL injection in child-table sync functions.** `syncJobSkills`, `syncJobCategories`, and `syncLocations` build `INSERT … VALUES` by interpolating raw values into SQL strings. Rewrite them with parameterized `?` placeholders (per-row inside a transaction, or a flat `VALUES (?, ?), (?, ?)` with a flat params array). Remove all hand-built SQL string values.  
  **Release type:** `fix(backend):` → **patch**  
  **Accept when:** a test passes attacker-controlled strings through `skillId`, `category_id`, `city_id`, and `raw_text` and verifies no SQL can escape the value context; all sync statements use parameter binding.  
  **Commit scope:** `fix(backend): parameterize child-table sync statements`
- [x] **BO3.5 — Replace per-job SELECT + UPDATE/INSERT with batched writes.** For each chunk (initially 100–250 jobs), do a pre-pass `SELECT` of existing `(source_id, external_id)` pairs plus their `content_hash`, then classify incoming jobs as new, unchanged, or changed. Issue separate `INSERT` for new jobs and `UPDATE` only for changed jobs; skip unchanged jobs entirely. Do not rely on `INSERT … ON DUPLICATE KEY UPDATE` affected-row counts to infer new-versus-updated, since MySQL client flags and no-op updates make that unreliable.  
  **Release type:** `refactor(backend):` → **no bump**  
  **Accept when:** a 900-job cycle issues far fewer statements than the per-job baseline, and new-vs-updated counts match the pre-pass classification.  
  **Commit scope:** `refactor(backend): batch job upserts by content classification`
- [x] **BO3.6 — Batch child-row reconciliation.** Reconcile skills, categories, and locations in batches. Avoid unconditional delete-and-reinsert when associations have not changed. Use parameterized statements.  
  **Release type:** `refactor(backend):` → **no bump**  
  **Accept when:** unchanged child associations are not deleted and re-inserted; changed associations update correctly.  
  **Commit scope:** `feat(backend): batch child association reconciliation`
- [x] **BO3.7 — Use bounded transactions with deadlock retry.** Wrap manageable chunks in transactions, not one transaction for the whole area. Add deadlock retry handling with a strict retry cap.  
  **Release type:** `feat(backend):` → **minor**  
  **Accept when:** a chunked transaction commits successfully, and a simulated deadlock retries up to the cap then fails loudly.  
  **Commit scope:** `feat(backend): bounded transactions with deadlock retry`
- [x] **BO3.8 — Add transform and repository tests.** Cover insert/update/no-op counts, child association changes, escaped input, transaction rollback, chunk boundaries, SQL injection resistance, and resolver batch-loading behavior.  
  **Release type:** `test(backend):` → **no bump**  
  **Accept when:** all new tests pass in `tests/transform/engine.test.ts`, `tests/transform/resolver.test.ts`, and `tests/persistence/JobRepository.test.ts`.  
  **Commit scope:** `test(backend): cover batched writes, content hash, and resolver batching`

**Phase exit criteria:** fewer database statements per 900-job cycle; unchanged-row writes eliminated; child-table sync uses parameterized statements; new-vs-updated counts accurate.

### Phase 4 — Move filtering and pagination into MySQL; audit indexes

- [x] **BO4.1 — Replace `findJobs()` with a parameterized repository method.** Accept validated filters, sort direction, `limit`, and `offset` (or cursor). Apply these in SQL using parameterized values and a fixed allowlist for sort-column names.  
  **Release type:** `feat(backend):` → **minor**  
  **Accept when:** `GET /api/jobs?limit=20&offset=0&sort=posted_at&sortDir=desc` pushes limit, offset, and sort into SQL; `SELECT *` no longer returns the whole table.  
  **Commit scope:** `feat(backend): push job filtering and pagination into SQL`
- [x] **BO4.2 — Implement placeholder category/skill/location/country filters.** Implement them as indexed joins only after expected behavior is covered by tests. Return a separate `COUNT(*)` or a `limit + 1` page when the API needs totals.  
  **Release type:** `feat(backend):` → **minor**  
  **Accept when:** category, skill, city, and country query parameters filter results at the database layer and are backed by tests.  
  **Commit scope:** `feat(backend): implement category/skill/location/country filters`
- [x] **BO4.3 — Select only required fields per endpoint.** Replace `SELECT *` with field-specific projections for each endpoint.  
  **Release type:** `refactor(backend):` → **no bump**  
  **Accept when:** API responses contain the same shape, but queries fetch fewer columns.  
  **Commit scope:** `refactor(backend): project required fields only`
- [x] **BO4.4 — Paginate and cap `listFetchRuns()`.** `listFetchRuns()` currently has unbounded result forms. Add limit/offset and a sensible cap.  
  **Release type:** `feat(backend):` → **minor**  
  **Accept when:** admin fetch-run history is bounded and paginated.  
  **Commit scope:** `feat(backend): paginate fetch-run history`
- [x] **BO4.5 — Audit indexes using query plans.** Use `EXPLAIN` on affected production queries to add only useful indexes. Verify the unique jobs key and existing indexes first. Candidate areas to measure: `fetch_runs(source_id, created_at)`, lookup columns used by auth/refresh tokens, and indexes on association foreign keys/filter columns. Do not add indexes blindly — each increases write and storage cost.  
  **Release type:** `perf(backend):` → **no bump**  
  **Accept when:** query plans show index usage for hot queries and no unnecessary indexes were added.  
  **Commit scope:** `perf(backend): add measured indexes`
- [x] **BO4.6 — Make pool limits configurable with a total budget.** Revisit pool sizing from observed concurrent queries. Make connection limits configurable and set a total budget across the API and fetcher processes, rather than assuming each process needs ten connections.  
  **Release type:** `feat(backend):` → **minor**  
  **Accept when:** `DB_POOL_LIMIT` (or similar) is configurable and the combined API+fetcher pool budget is documented and below the previous 20-connection maximum.  
  **Commit scope:** `feat(backend): configurable pool budget across processes`
- [x] **BO4.7 — Validate query plans and API response compatibility.** Verify query plans and API response compatibility before rollout.  
  **Release type:** `test(backend):` → **no bump**  
  **Accept when:** staging run shows lower database reads, Node memory use, and CPU for the jobs list.  
  **Commit scope:** `test(backend): validate query plans and API compatibility`

**Phase exit criteria:** jobs list filtered/sorted/paginated in SQL; placeholder filters implemented; indexes justified by query plans; pool budget shared across processes.

### Phase 5 — Define a real database adapter/repository boundary

Today there is no real boundary. `src/database/db.ts` imports only `mysql2/promise`; `src/persistence/JobRepository.ts` and `src/database/migrations.ts` call mysql2 functions directly and embed MySQL-specific SQL (`ON DUPLICATE KEY UPDATE`, `ENUM`, backtick identifiers, `information_schema` queries); `DB_DIALECT=sqlite` is a no-op. `JobRepository` is a concrete class instantiated directly everywhere, with no interface and no dependency injection.

Changing databases later would require rewriting every SQL string in `JobRepository.ts` and `migrations.ts`, not swapping a config value. This phase introduces a proper boundary so a different driver can be swapped behind the same repository interface without touching application behavior.

- [x] **BO5.1 — Define a repository interface.** Extract an interface (or abstract class) from `JobRepository` covering all persistence operations (`upsertJob`, `syncJobSkills`, `syncJobCategories`, `syncLocations`, `findJobs`, `listFetchRuns`, `listSources`, `listSkills`, `listCategories`, `listCities`, `listCountries`, `createFetchRun`, `updateFetchRun`, etc.).  
  **Release type:** `refactor(backend):` → **no bump**  
  **Accept when:** `JobRepository` implements a typed interface and every public repository method is declared on it.  
  **Commit scope:** `refactor(backend): define repository interface`
- [x] **BO5.2 — Decouple `JobRepository` from `mysql2/promise`.** `JobRepository` currently imports `query` and `execute` directly from `../database/db`. Introduce a driver-agnostic connection/query abstraction (e.g. an interface with `query(sql, params?)`, `execute(sql, params?)`, `transaction(fn)`) and inject it into `JobRepository` instead of importing mysql2 directly.  
  **Release type:** `refactor(backend):` → **no bump**  
  **Accept when:** `JobRepository` no longer imports `mysql2/promise`; it calls methods on an injected connection abstraction.  
  **Commit scope:** `refactor(backend): decouple repository from mysql2`
- [x] **BO5.3 — Move MySQL-specific SQL into a MySQL driver implementation.** All inline MySQL SQL in `JobRepository.ts` and `migrations.ts` (`ON DUPLICATE KEY UPDATE`, `ENUM` types, `information_schema` column checks, backtick identifiers) lives behind a MySQL driver that implements the connection/query abstraction.  
  **Release type:** `refactor(backend):` → **no bump**  
  **Accept when:** no repository method or migration contains MySQL-dialect SQL directly; all such SQL is in the MySQL driver layer.  
  **Commit scope:** `refactor(backend): move MySQL SQL into MySQL driver`
- [x] **BO5.4 — Wire dependency injection at startup.** `src/daemon/index.ts:21` instantiates `new JobOrchestrator()` with no arguments, and `src/api/server.ts:31-48` creates `new JobRepository()` inline in each route handler. Wire DI so both services receive a `JobRepository` built with the configured driver (currently MySQL via `DB_DIALECT`). `DB_DIALECT` selects the driver implementation rather than being ignored — `src/config/index.ts:64` already defines `dbDialect` but `src/database/db.ts` never reads it and always creates a MySQL pool.  
  **Release type:** `refactor(backend):` → **no bump**  
  **Accept when:** `DB_DIALECT` controls which driver is instantiated; the fetcher daemon and API server construct repositories without knowing the driver; no file instantiates `JobRepository` directly without an injected driver.  
  **Commit scope:** `refactor(backend): dependency-inject repository driver`
- [x] **BO5.5 — Add driver-swap tests.** Verify the repository test suite passes against the MySQL driver, and that the same tests can run against a fake/in-memory driver implementation to prove the boundary is real.  
  **Release type:** `test(backend):` → **no bump**  
  **Accept when:** repository tests pass against MySQL and against an in-memory driver stub; no test references mysql2-specific types.  
  **Commit scope:** `test(backend): verify repository interface with MySQL and in-memory drivers`

**Phase exit criteria:** a real database adapter/repository boundary exists; `JobRepository` depends on an injected driver abstraction; MySQL-specific SQL is isolated behind the MySQL driver; `DB_DIALECT` actually selects a driver; repository tests pass against both a real driver and an in-memory stub. This makes a future database swap a driver implementation task, not a rewrite of every SQL string.

## Rollout and success criteria

Implement one phase at a time, preserving a reversible deployment. Begin with the serialized round-robin scheduler and upstream request throttle, then optimize each batch's database work. Keep a release tag and tested backup before schema or database changes.

Verify each phase against the existing behavior and a representative fetch. Success means:

- lower fetcher and MySQL CPU/RSS and disk writes;
- fewer database statements per 900-job cycle and fewer unchanged-row writes;
- no repeated or overlapping source-area/proactive cycles;
- no missing jobs, associations, or regressions in API filtering/pagination;
- bounded cycle duration and upstream request rate;
- documented data freshness derived from the number and durations of work items and `POLL_INTERVAL_MS`, with acceptable API latency.

If the VPS remains CPU-bound after reducing redundant work, use profiling to identify whether time is spent in Node transform/JSON processing, MySQL, PMTiles decoding, or another process before considering additional throttling or a database migration.

## Cross-cutting quality requirements

- Every repository change must use parameterized `?` placeholders; no string interpolation of values into SQL.
- Every new behavior must have a corresponding test before the item is accepted.
- Every schema change needs a migration, a release tag, and a tested backup before rollout.
- No item is considered complete until its acceptance check passes and its commit scope is committed.
- Changes must remain reversible within the phase they are introduced in.

## Suggested first milestone

Deliver Phase 1 first: serialized scheduler, round-robin rotation, proactive duplicate-guard fix, semaphore removal, backoff/`Retry-After`, and scheduler tests. This reduces repeated work immediately with no change to transform output, making later phases safer to measure.