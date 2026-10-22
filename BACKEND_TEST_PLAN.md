# Backend Test Plan

## Purpose

Add an automated, repeatable test suite for the backend's authentication, API, persistence, transformation, source-adapter, and daemon-orchestration behavior. Tests must run without a live MySQL database or calls to Rezi, and must not read or alter production/local database state.

## Baseline findings

- The backend currently has no automated test files or test script.
- `npm run build` passes before test changes.
- The implementation is strict TypeScript using CommonJS; tests should not weaken production compiler settings.
- Database access is centralized in `src/database/db.ts`, which permits repository/migration tests to mock the database boundary.
- API routers instantiate `JobRepository` at module scope, so route tests can mock the repository module and mount each router in a small Express test app.
- Rezi requests use global `fetch`; PMTiles uses `pmtiles`. Tests should mock network and archive boundaries rather than access external services.
- The existing `.env` and pre-existing untracked data/reports are outside test ownership. Tests must use explicit test environment values and temporary/in-memory fixtures.

## Test conventions and safety

- Use Vitest for TypeScript unit tests and Supertest for HTTP-level router tests.
- Use only deterministic fixtures, fake timers where appropriate, and mocks for MySQL, PMTiles, and external HTTP.
- Never run destructive database commands or seed a developer database during automated tests.
- Keep each implementation step focused, run its targeted tests and the production TypeScript build, then commit only the files created or changed for that step.
- Do not add, stage, or commit pre-existing untracked files.
- Mark an item complete only after its acceptance checks pass.

## Implementation steps

### B1 — Establish test infrastructure and test foundational utilities

Add Vitest/Supertest development dependencies, a Vitest configuration and isolated test setup, and `npm test`/watch scripts. Add focused tests for token signing/verification and password/token hashing, authentication middleware, rate-limit behavior, and configuration parsing where it can be tested without leaking cached environment state.

**Accept when:** tests run without MySQL or network access; representative auth/authorization, hash, and rate-limit contracts pass; `npm run build` still passes.
**Commit scope:** `test(backend): establish test harness and utility coverage`

### B2 — Test Rezi PMTiles and adapter behavior

Test geographic tile range and binary varint decoding, missing/corrupt tile handling, tile limits and deduplication; test the passive and keyword-driven adapter flows with mocked PMTiles/fetch/rate limiting, including batching, pagination, response-envelope variants, warnings, and invalid records.

**Accept when:** tests are deterministic and verify valid normalized results as well as failure/empty-result behavior without external calls.
**Commit scope:** `test(backend): cover Rezi source adapter`

### B3 — Test transform engine and entity resolution

Test field transforms, missing required job data, new and existing job upserts, relation resolution/caching, duplicate child entities, warning collection, and synchronization of skills/categories/locations using a fake repository.

**Accept when:** representative raw records produce the expected normalized persistence calls and invalid records are skipped with warnings.
**Commit scope:** `test(backend): cover transform and entity resolution`

### B4 — Test HTTP API routers

Mount routers in an isolated Express app and mock repository operations. Cover authentication login/refresh/logout/me, public and protected access, user/category-interest authorization, jobs validation/filtering/pagination, administrator CRUD and validation, and master-data seed/link contracts.

**Accept when:** success, validation, unauthenticated, unauthorized, not-found, and conflict outcomes are verified for supported routes without a real database.
**Commit scope:** `test(backend): cover REST API routes`

### B5 — Test repository and database lifecycle boundaries

Mock the centralized database functions to verify repository query parameters, upsert versus update paths, pagination/filter query construction, fetch-run updates, and transaction commit/rollback/release behavior. Verify migration creation and the idempotent `working_mode` migration through mocked SQL calls; test admin seeding as an idempotent operation with mocked repository/auth functions.

**Accept when:** SQL behavior and parameterization are asserted, transaction failure rolls back and releases, and no test connects to MySQL.
**Commit scope:** `test(backend): cover persistence and migrations`

### B6 — Test orchestrator scheduling and cycle outcomes

Use a fake repository, controlled timers, and mocked source/transform boundaries to verify working-mode selection, passive source-area and proactive keyword cycles, concurrency limits, retries/timeouts, per-pair isolation, fetch-run finalization, timestamps, and clean stopping behavior.

**Accept when:** representative success, failure, retry, no-work, and concurrent-cycle cases run deterministically without starting the daemon or contacting Rezi/MySQL.
**Commit scope:** `test(backend): cover orchestrator cycles`

### B7 — Run full suite and record verified coverage

Run the complete test suite and production build; fix failures caused by test setup or test-coupled defects, and update this plan with the executed results and any explicitly uncovered integration limitations.

**Accept when:** all tests pass from a clean run, `npm run build` passes, and the plan accurately reports completed coverage.
**Commit scope:** `test(backend): verify complete test suite`

## Current status

- [x] Inventory backend modules and establish the pre-test build baseline.
- [x] B1 — Test infrastructure and foundational utilities (**13 tests passed**).
- [x] B2 — Rezi PMTiles and source adapter (**10 tests passed**); fixed duplicate warning aggregation in detail-fetch results.
- [x] B3 — Transform engine and entity resolution (**7 tests passed**); corrected persisted job IDs in relation sync, deduplicated categories/locations, and prevented city rows with fabricated country IDs.
- [x] B4 — HTTP API routers (**17 tests passed**); added cookie parsing to the API server so refresh-token cookies reach authentication routes.
- [x] B5 — Repository and database lifecycle (**15 tests passed**); verified parameterized repository operations, pool/transaction cleanup, idempotent migration behavior, and admin seeding without a live database.
- [x] B6 — Orchestrator scheduling and cycles (**9 tests passed**); filtered passive pairs by working mode, cleared timeout timers, and made stop cancel polling and skip not-yet-started proactive work.
- [ ] B7 — Full suite and final verification.

## Known test boundaries

- Tests in this plan validate application contracts with mocked boundaries. They do not replace a separately configured MySQL integration run, live Rezi request validation, or production deployment smoke tests.
- Any test that would require credentials, external network access, or mutations to a developer database must remain opt-in and must use explicitly provisioned isolated resources.
