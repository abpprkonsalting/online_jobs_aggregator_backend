# Next Steps: Backend Implementation

## Summary of Planning Work Completed

All three planning files have been updated and aligned:

### DATA_MODEL.md
- **14 tables** defined: sources, geographic_areas, source_geographic_areas, fetch_runs, countries, cities, locations, skills, job_skills, categories, job_categories, jobs, users, refresh_tokens
- Standardized geographic area definition: `{bbox: [min_lon, min_lat, max_lon, max_lat], zoom: integer}`
- Many-to-many `source_geographic_areas` table linking sources to areas (enabled flag, timestamps per pair)
- Removed `type` field and `config_override` per user requirements; phase 1 uses Rezi-native bbox+zoom
- Master tables (`skills`, `categories`, `cities`, `countries`, `geographic_areas`) are **frontend-owned**; pipeline never creates/updates/deletes them
- Fixed section numbering (1-14 sequential)

### PLAN.md
- **FR-14** (authentication) and **FR-15** (admin endpoints) added to requirements
- Architecture diagram includes **Auth Layer (JWT + bcrypt)** between Frontend and REST API
- Components table lists auth routes, user management, auth middleware
- Roadmap: Phase 3 = "Implement Auth layer" (JWT login/refresh/logout, bcrypt password hashing, role middleware, seed admin user)
- All 25 inconsistencies in `plan_backend_inconsistencies.md` resolved and marked "Done"

### plan_backend.md
- **Architecture diagram** (§2) now includes: Auth Layer → REST API Layer → Orchestrator → JobSource Adapters → Transform ETL → Persistence
- **§7 REST API Layer**: Endpoint definitions for jobs, master tables, admin CRUD, and auth
- **§8 Auth Layer**: JWT access tokens + httpOnly refresh tokens, role-based access control (`admin`/`user`), v1 scope decision
- **§5.1 Transform Engine Design**: Master tables not auto-created; adapter handles mismatches via config translation or fuzzy matching
- **§5.2 Rezi mapping**: Standard definition `{bbox, zoom}` is Rezi's native format — no translation needed for phase 1
- **Persistence**: `sync` only on per-job child tables (`job_skills`, `job_categories`, `locations`); master tables never synced/deleted
- **§11 Next Steps**: 13 steps from types → daemon bootstrap + seed admin → run fetching cycle → finalize

### plan_backend_inconsistencies.md
- All 25 issues marked **Done**, including:
  - Issue #1: REST API completely defined and added
  - Issue #14: sync vs upsert resolved (master tables frontend-only, sync only on child tables)
  - Issue #22: Architecture diagram missing REST API layer (updated)

## Current State: Ready to Implement Backend

**✅ Planning is complete.** All design decisions, data models, API contracts, architecture, and risk mitigations are documented and consistent across files.

**🚀 Ready to start backend implementation.**

## Implementation Roadmap (from plan_backend.md §13)

1. **Define types**: `JobSource`, `FetchResult`, `FetchRunMetrics`, auth (user, token), normalized types
2. **Scaffold**: `package.json`, `JobRepository`, config + logger + rate limiter
3. **Auth layer**: `/api/auth/*` routes, JWT middleware (`requireAuth`, `requireRole`), bcrypt password hashing, seed admin user from `.env`
4. **Transform engine**: Adapt `lmp_scraper` transform ETL to `JobRepository` (replace Supabase persistence)
5. **Rezi adapter**: Author `rezi.transform.json` + `ReziJobSource` + PMTiles utilities (raw payload only)
6. **REST API layer**: Routes/controllers for: jobs, master tables, admin, auth
7. **Daemon entrypoint**: Bootstrap DB, seed admin user from `.env`, start fetching cycle against Rezi (small bbox)
8. **Validation**: Dedup + normalized persistence + `fetch_runs` metadata
9. **Polish**: Per-source `retry`/pacing, graceful shutdown, prepare for future sources

## Key Files to Create (not in repo yet)

Based on `plan_backend.md` deliverables table, these files need to be created:

**Auth & Users:**
- `backend/src/middleware/auth.ts` — JWT middleware + role-based authorization
- `backend/src/utils/auth.ts` — Token sign/verify, bcrypt hash/verify helpers
- `backend/src/api/auth.ts` — Auth routes (login, refresh, logout, me)
- `backend/src/api/users.ts` — User management routes (CRUD, admin only)

**REST API:**
- `backend/src/api/jobs.ts` — Job list/detail endpoints
- `backend/src/api/master.ts` — Master table seed/snapshot endpoints
- `backend/src/api/admin.ts` — Admin endpoints (sources, areas, fetch_runs)

**Transform & Adapter:**
- `backend/src/transform/rezi.transform.json` — Rezi per-adapter transform_config
- `backend/src/sources/rezi/ReziJobSource.ts` — Rezi adapter
- `backend/src/sources/rezi/pmtiles.ts` — PMTiles parsing utilities

**Daemon:**
- `backend/src/orchestrator/JobOrchestrator.ts` — RxJS-style daemon loop
- `backend/src/daemon/index.ts` — Daemon entrypoint
- `backend/.env` / `backend/.env.example` — Environment variables (incl: JWT_SECRET, JWT_ACCESS/REFRESH_EXPIRES_IN, ADMIN_EMAIL, ADMIN_PASSWORD, DATABASE_URL, etc.)

**Config & Utils:**
- `backend/src/config/index.ts` — Env-first config with defaults + bootstrap
- `backend/src/utils/logger.ts` — Multi-driver logger
- `backend/src/utils/rate-limiter.ts` — Per-source pacing helper
- `backend/src/types/normalized.ts` — Normalized types aligned with DATA_MODEL.md

## No Code Changes Needed

The following are **planning artifacts only** — no backend code exists yet, and that's expected:
- All `DATA_MODEL.md` table definitions
- All `PLAN.md` requirements, architecture, roadmap
- All `plan_backend.md` design decisions and next steps
- All `plan_backend_inconsistencies.md` issue resolutions

## What You'll Feed to the Next Conversation

This `next_steps.md` file captures the complete planning output and can be handed off to continue implementation. The key handoff points are:

1. **Types & config** (step 1)
2. **Auth layer** (step 3) — including JWT setup, endpoints, middleware
3. **Transform & adapter** (steps 4-5) — including the `lmp_scraper` adaptation and Rezi transform_config
4. **REST API + daemon** (steps 6-8) — full implementation order

The files are all aligned and consistent. You're ready to start writing actual Node.js/Express code from this planning foundation.