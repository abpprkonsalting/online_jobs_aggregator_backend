# User Manual: Map Rezi Backend

## 1. Project Overview

The Map Rezi Backend is a Node.js + Express + TypeScript service that powers the Online Jobs Aggregator platform. It provides a REST API for browsing job listings, user authentication and authorization, master data management, and administrative operations. It also includes a background fetcher daemon that continuously scrapes job sources (Rezi map and Rezi app) and normalizes the data into the system's database.

The backend is designed for 24/7 deployment on a VPS behind Apache (reverse proxy) and MySQL. It uses systemd for process management and GitHub Actions for CI/CD deployment.

**Target audience:** job aggregator platform operators, administrators, and frontend developers integrating with the API.

**Deployment target:** Debian 13 VPS running Node.js 24, Apache, MySQL 8, and systemd.

---

## 2. System Architecture (Simplified)

```
Client (browser / mobile app)
        │
        ▼
   Apache (reverse proxy + static file server)
        │  /api ─────────────────────────────▶  Node.js API (port 3000)
        │                                               │
        │                                               ▼
        │                                        MySQL Database (map_rezi)
        │                                               │
        │                               ┌───────────────┴───────────────┐
        │                               ▼                               ▼
        │                         Job Repository                Source Orchestrator
        │                               │                               │
        │                               ▼                               ▼
        │                         Normalized Jobs           Rezi Map / Rezi App
        │                               │                     Fetch Adapters
        │                               ▼                               │
        └─────────────────────────────────────────────────────────────────┘
        │
        ▼
   Static Frontend Assets (served by Apache)
```

### Components

| Component | Responsibility |
|---|---|
| **API Server** (`dist/api/server.js`) | Express application exposing all REST endpoints. Initializes the database and seeds the admin user on startup. |
| **Fetcher Daemon** (`dist/daemon/index.js`) | Background process that polls configured sources on a schedule and runs fetch cycles (passive and proactive). |
| **Job Repository** | Data access layer for jobs, skills, categories, cities, countries, users, sources, fetch runs, and unified keywords. |
| **Source Orchestrator** | Manages fetch cycles: passive (source + geographic area pairs) and proactive (user-defined keywords). Handles retries, rate limiting, and timeouts. |
| **Fetch Adapters** | Source-specific logic: `ReziMapJobSource` (map-driven keyword search) and `ReziAppJobSource` (job-board search). Both implement the `JobSource` interface. |
| **Transform System** | Normalizes raw scraped job data into the system's canonical schema (skills, categories, locations, salary). |

### Data Flow

1. **API Request**: Client sends an authenticated request to Apache, which proxies `/api` to the Node.js API on port 3000. Login and refresh are the only API operations available without an access token; refresh requires a valid refresh cookie.
2. **Database Query**: The API queries MySQL via `mysql2` and returns JSON responses.
3. **Fetch Cycle (Daemon)**: The orchestrator runs on a `POLL_INTERVAL_MS` schedule. For each enabled source, it either fetches by geographic area (passive) or by keyword (proactive), writes results to the database, and records a `fetch_run`.
4. **Admin Operations**: Administrators manage sources, geographic areas, users, and master data through protected admin endpoints.

---

## 3. API Reference

### Authentication

All application data endpoints require a valid access token sent as `Authorization: Bearer <token>`. The access token is short-lived (15 minutes by default). Login is public; refresh and logout use the httpOnly refresh cookie.

#### POST /api/auth/login
Authenticate a user and receive an access token.

**Request Body:**
```json
{
  "email": "admin@example.com",
  "password": "ChangeMe123!"
}
```

**Response:**
```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": 1,
    "email": "admin@example.com",
    "role": "admin"
  }
}
```

#### POST /api/auth/refresh
Obtain a new access token using the httpOnly refresh cookie.

**Request:** Cookie `refresh_token` must be present.

**Response:**
```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

#### POST /api/auth/logout
Clear the refresh cookie and invalidate the session.

**Response:**
```json
{ "success": true }
```

#### GET /api/auth/me
Return the currently authenticated user.

**Response:**
```json
{
  "id": 1,
  "email": "admin@example.com",
  "role": "admin"
}
```

### Deployment version

#### GET /api/version
Return non-sensitive version metadata for the running API process. This endpoint is public and does not include credentials, filesystem paths, or the artifact manifest.

**Response:**
```json
{
  "releaseTag": "v1.2.3",
  "buildStatus": "release",
  "commitSha": "<full Git commit SHA>",
  "buildTimestampUtc": "<UTC timestamp>",
  "environment": "production",
  "deploymentId": "<workflow run ID and attempt>"
}
```

Untagged commits report `releaseTag: null` and `buildStatus: "untagged"`; local development without generated build metadata reports `buildStatus: "development"`.

---

### Jobs (Authenticated)

#### GET /api/jobs
List jobs with filtering, sorting, and pagination.

**Query Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `limit` | number | Maximum number of jobs to return (default: 20) |
| `offset` | number | Number of jobs to skip (default: 0) |
| `sort` | string | Sort field (e.g., `posted_at`, `title`) |
| `sortDir` | string | Sort direction: `asc` or `desc` |
| `category` | string | Filter by category slug |
| `skill` | string | Filter by skill slug |
| `city_id` | number | Filter by city ID |
| `country_id` | number | Filter by country ID |
| `source_id` | string | Filter by source ID |
| `allow_remote` | boolean | Filter remote jobs |
| `salary_min` | number | Minimum salary |
| `salary_max` | number | Maximum salary |
| `organization` | string | Filter by organization name |

**Response:**
```json
{
  "jobs": [
    {
      "id": "uuid",
      "title": "Software Engineer",
      "organization": "Acme Corp",
      "job_url": "https://example.com/job/123",
      "employment_type": "Full-time",
      "date_posted": "2026-10-20T10:00:00Z",
      "locations_derived": ["New York, NY"],
      "cities_derived": ["New York"],
      "countries_derived": ["United States"],
      "remote_derived": true,
      "salary_currency": "USD",
      "salary_min_value": 100000,
      "salary_max_value": 150000,
      "salary_unit_text": "YEAR",
      "ai_key_skills": ["TypeScript", "React", "Node.js"],
      "experience_level": "Mid",
      "work_arrangement": "Hybrid",
      "description_text": "...",
      "days_waiting": 5
    }
  ],
  "total": 150,
  "hasMore": true
}
```

#### GET /api/jobs/:id
Return a single job detail with related skills, categories, locations, and days waiting.

---

### Reference Data (Authenticated)

#### GET /api/categories
List all job categories.

#### GET /api/skills
List all job skills.

#### GET /api/cities
List all cities.

#### GET /api/countries
List all countries.

### Master Data Management (Admin)

#### GET /api/master/schema
Return the complete master data schema: countries, cities, skills, categories, and geographic areas.

#### POST /api/master/seed-skills
Bulk seed skills.

**Request Body:**
```json
{
  "skills": [{ "name": "TypeScript", "slug": "typescript" }]
}
```

#### POST /api/master/seed-cities
Bulk seed cities.

#### POST /api/master/seed-countries
Bulk seed countries.

#### POST /api/master/seed-categories
Bulk seed categories.

---

### Admin Endpoints (Admin Role Only)

All admin endpoints require `Authorization: Bearer <admin_access_token>`.

#### Sources

| Method | Path | Description |
|---|---|---|
| GET | `/api/admin/sources` | List all sources |
| POST | `/api/admin/sources` | Create a source |
| PATCH | `/api/admin/sources/:id` | Update a source |
| DELETE | `/api/admin/sources/:id` | Delete a source |

**Source Object:**
```json
{
  "id": "uuid",
  "name": "rezi-map",
  "type": "rezi",
  "working_mode": "both",
  "config": {},
  "enabled": true,
  "last_run_at": null
}
```

`working_mode` values: `passive`, `proactive`, `both`.

#### Geographic Areas

| Method | Path | Description |
|---|---|---|
| GET | `/api/admin/geographic-areas` | List all geographic areas |
| POST | `/api/admin/geographic-areas` | Create a geographic area |
| PUT | `/api/admin/geographic-areas/:id` | Update a geographic area |
| DELETE | `/api/admin/geographic-areas/:id` | Delete a geographic area |

#### Source/Area Assignments

| Method | Path | Description |
|---|---|---|
| GET | `/api/admin/areas` | List source/area assignments |
| POST | `/api/admin/areas` | Link a source to a geographic area |
| DELETE | `/api/admin/areas/:source_id/:area_id` | Unlink a source from a geographic area |

#### Fetch Runs

| Method | Path | Description |
|---|---|---|
| GET | `/api/admin/fetch-runs` | List recent fetch runs (optional `?source_id=`) |

#### Master Schema

| Method | Path | Description |
|---|---|---|
| GET | `/api/admin/master/schema` | Return full master data schema |

---

### Users (Admin Role Only)

| Method | Path | Description |
|---|---|---|
| GET | `/api/users` | List all users |
| POST | `/api/users` | Create a user |
| PATCH | `/api/users/:id` | Update user role |
| DELETE | `/api/users/:id` | Deactivate a user |

**User Object:**
```json
{
  "id": 1,
  "email": "user@example.com",
  "role": "user"
}
```

---

## 4. Configuration Reference

Configuration is provided via environment variables, typically in a `.env` file located in the backend working directory. The backend uses `dotenv` to load variables on startup.

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| **Server** |
| `NODE_ENV` | No | `development` | Runtime mode: `development` or `production` |
| `PORT` | No | `3000` | TCP port for the API server |
| **Database** |
| `DATABASE_URL` | Yes | — | MySQL connection string (e.g. `mysql://user:pass@localhost:3306/map_rezi`) |
| `DB_DIALECT` | No | `mysql` | Database dialect (`mysql` or `sqlite`) |
| **Source Config** |
| `SOURCES_CONFIG_PATH` | No | `./config/sources.json` | Path to sources configuration JSON |
| `ENABLED_SOURCES` | No | `rezi-map` | Comma-separated list of enabled source names |
| **Polling / Scheduling** |
| `POLL_INTERVAL_MS` | No | `5000` | Milliseconds between orchestrator poll cycles |
| `MAX_CONCURRENT_SOURCES` | No | `3` | Maximum concurrent fetch cycles |
| `MAX_RETRIES` | No | `3` | Maximum retry attempts per fetch |
| `RETRY_DELAY_MS` | No | `60000` | Milliseconds between retry attempts |
| `API_TIMEOUT_MS` | No | `30000` | Timeout for external API requests |
| `FETCH_TIMEOUT_MS` | No | `1800000` | Timeout for a complete fetch cycle |
| `STALLED_THRESHOLD_MS` | No | `3600000` | Milliseconds before a fetch is considered stalled |
| **Logging** |
| `LOG_LEVEL` | No | `info` | Minimum log level (`debug`, `info`, `error`) |
| `LOG_DIR` | No | `./logs` | Directory for log files |
| `LOGGERS` | No | `["console"]` | JSON array of active log drivers |
| `CACHE_DIR` | No | `./cache` | Directory for disk cache files |
| **Authentication** |
| `JWT_SECRET` | Yes | — | 32+ character secret for signing JWT access tokens |
| `JWT_ACCESS_EXPIRES_IN` | No | `15m` | Access token expiry (e.g. `15m`, `1h`) |
| `JWT_REFRESH_EXPIRES_IN` | No | `7d` | Refresh token expiry |
| `COOKIE_DOMAIN` | No | `` | Cookie domain for refresh token (set to your VPS domain in production) |
| **Admin Seed** |
| `ADMIN_EMAIL` | Yes | — | Email for the admin user seeded on first run |
| `ADMIN_PASSWORD` | Yes | — | Password for the admin user seeded on first run |

### Recommended Production Values

```
NODE_ENV=production
PORT=3000
LOG_LEVEL=info
LOGGERS=["console","local"]
LOG_DIR=/var/log/map_rezi
CACHE_DIR=/var/www/map_rezi/backend/cache
JWT_ACCESS_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d
COOKIE_DOMAIN=<your-domain>
```

---

## 5. Installation & Local Development

### Prerequisites

- Node.js 20+ (tested with Node 24)
- npm
- MySQL 8.0+ (local or remote)

### Steps

```bash
# 1. Enter the backend directory
cd backend

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env with your MySQL connection, JWT secret, and admin credentials

# 4. Create the database
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS map_rezi;"

# 5. Build TypeScript
npm run build

# 6. Run the API server
node -r dotenv/config dist/api/server.js

# 7. Run the fetcher daemon (separate terminal)
npm run dev
```

The API will be available at `http://localhost:3000/api`.

### Scripts

| Script | Purpose |
|---|---|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run api` | Start the API server with ts-node (development) |
| `npm run dev` | Start the fetcher daemon with ts-node (development) |
| `npm start` | Start the fetcher daemon from `dist/` (production) |

---

## 6. Production Deployment (Debian 13 + Apache + systemd)

The supported VPS deployment runs the API and fetcher as separate systemd services. Apache serves the frontend over HTTPS, redirects HTTP to HTTPS, and proxies `/api` requests to the backend on loopback. See [DEPLOY_VPS.md](./DEPLOY_VPS.md) for the complete VPS setup procedure and current workflow details.

### Deployment requirements and order

1. Prepare the VPS with Node.js 24, Apache, MySQL, the application directories, a restricted SSH `deploy` account, and a separate non-login `map_rezi` service account.
2. Configure the Apache HTTPS virtual host. Install the site's TLS certificate and private key on the VPS, set their paths in `systemd/apache-map-rezi.conf`, enable `ssl`, `proxy`, `proxy_http`, `rewrite`, and `headers`, and verify the Apache configuration.
3. Add `deploy` to the `map_rezi` group, make the backend deployment tree owned by `deploy:map_rezi` with group read/traverse permissions, and protect `.env` with mode `0640`. No ACL package or ACL rules are required. Install `systemd/map-rezi-api.service` and `systemd/map-rezi-fetcher.service`, reload systemd, and enable the units **without starting them**. Do not use `enable --now` before the first application deployment.
4. Configure the production `.env` as the GitHub Actions `BACKEND_ENV` secret. It must include database credentials, a strong `JWT_SECRET`, admin credentials, and the production `COOKIE_DOMAIN`. Never commit this file.
5. Configure the GitHub Actions deployment secrets: `VPS_HOST`, `VPS_SSH_PORT`, `VPS_USER`, `VPS_SSH_KEY`, and `VPS_SSH_KNOWN_HOSTS`. The host-key entry must match the exact host and non-default port used by the workflow; verify its fingerprint through a trusted channel.
6. Grant the deploy account passwordless sudo only for the required service restart command. If deploying the frontend from Actions to the same VPS, also grant only the Apache reload command; do not grant unrestricted sudo access. The deploy account owns uploaded code; the service account runs the daemons and can read code and `.env` but cannot modify them.
7. Push an approved annotated release tag such as `v1.2.3`. GitHub Actions installs dependencies, tests and builds TypeScript, transfers `dist/`, `.env`, `package.json`, and `package-lock.json`, installs production dependencies on the VPS, and restarts both services. Pushes to `master` run CI only and do not deploy. See [RELEASE_WORKFLOW.md](./RELEASE_WORKFLOW.md) for the current single-maintainer process and the planned version 2 pull-request workflow.

The API and fetcher run as the non-login Linux account `map_rezi` and load the deployed `.env` from their backend working directory. The SSH deployment account `deploy` is only used by GitHub Actions to transfer files and request the narrowly permitted service restart. Keep MySQL private and do not expose backend port 3000 publicly; Apache should reach it through `127.0.0.1`. Apache must forward browser `Cookie` headers to `/api` so refresh and logout requests work. The proxy rewrites the refresh cookie path for the `/api` routes. See [DEPLOY_VPS.md](./DEPLOY_VPS.md) for the migration steps when services are currently running as `deploy`.

---

## 7. Operations & Monitoring

### Checking Service Status

```bash
# API service
sudo systemctl status map-rezi-api

# Fetcher daemon
sudo systemctl status map-rezi-fetcher

# Apache
sudo systemctl status apache2

# MySQL
sudo systemctl status mysql
```

### Viewing Logs

```bash
# API and fetcher logs (startup entries include release status/tag, commit SHA,
# service name, and deployment ID when available)
sudo journalctl -u map-rezi-api -u map-rezi-fetcher -n 100 --no-pager

# Apache logs
sudo tail -f /var/log/apache2/map_rezi_error.log
sudo tail -f /var/log/apache2/map_rezi_access.log
```

### Health Check

```bash
# Without an access token, protected data endpoints should return HTTP 401.
curl -i http://127.0.0.1:3000/api/categories

# After signing in and setting ACCESS_TOKEN from the login response:
curl -sS -H "Authorization: Bearer $ACCESS_TOKEN" \
  http://127.0.0.1:3000/api/categories | head -c 200
curl -sS -H "Authorization: Bearer $ACCESS_TOKEN" \
  https://jobs-agregator.abpprkonsalting.com/api/categories | head -c 200

# The public version response should match the intended deployment.
curl -fsS http://127.0.0.1:3000/version
curl -fsS https://jobs-agregator.abpprkonsalting.com/api/version
```

### Restarting Services

```bash
# After config changes
sudo systemctl restart map-rezi-api
sudo systemctl restart map-rezi-fetcher
sudo systemctl reload apache2
```

---

## 8. Troubleshooting

### API won't start

| Symptom | Likely Cause | Fix |
|---|---|---|
| `Missing required env var: DATABASE_URL` | `.env` missing or not loaded | Verify `.env` exists in working directory and contains `DATABASE_URL` |
| `Missing required env var: JWT_SECRET` | JWT secret not set | Add `JWT_SECRET` (32+ chars) to `.env` |
| `Missing required env var: ADMIN_EMAIL` | Admin email not set | Add `ADMIN_EMAIL` and `ADMIN_PASSWORD` to `.env` |
| Port 3000 already in use | Another process on port 3000 | Check `sudo ss -tlnp | grep 3000` and free the port |
| MySQL connection refused | MySQL not running or wrong credentials | Verify MySQL is running and `DATABASE_URL` is correct |

### Fetcher daemon issues

| Symptom | Likely Cause | Fix |
|---|---|---|
| No fetch runs recorded | No enabled sources in database | Add sources via `/api/admin/sources` |
| Fetch cycles timing out | Target site slow or unreachable | Increase `FETCH_TIMEOUT_MS` or check network |
| High memory usage | Too many concurrent browsers/sources | Reduce `MAX_CONCURRENT_SOURCES` |

### Authentication issues

| Symptom | Likely Cause | Fix |
|---|---|---|
| Login returns 401 | Wrong credentials or admin not seeded | Verify `ADMIN_EMAIL`/`ADMIN_PASSWORD` in `.env` and restart API |
| Refresh token cookie not sent | `COOKIE_DOMAIN` mismatch or HTTP vs HTTPS | Set `COOKIE_DOMAIN` to your domain; ensure HTTPS in production |
| Protected endpoint returns 401 | Missing or expired `access_token` | Include `Authorization: Bearer <token>` header |

### Apache / Proxy issues

| Symptom | Likely Cause | Fix |
|---|---|---|
| 502 Bad Gateway | Backend not running or not on port 3000 | Check `map-rezi-api` status and port binding |
| CORS errors | Frontend on different origin | Deploy both on same origin via Apache, or configure CORS on backend |
| SPA routes return 404 | Missing Apache rewrite fallback | Ensure `RewriteRule ^ /index.html [L]` is in the virtual host |

---

## 9. Safety & Limits

### Secrets Management

- Never commit `.env` to git. It contains database credentials, JWT secret, and admin password.
- Inject `.env` at deploy time via the `BACKEND_ENV` GitHub secret.
- Rotate `JWT_SECRET` and database passwords periodically.

### Rate Limiting

- `MAX_CONCURRENT_SOURCES` controls how many fetch cycles run simultaneously. Default is 3.
- `POLL_INTERVAL_MS` controls how often the orchestrator polls. Default is 5000ms.
- Do not set `MAX_CONCURRENT_SOURCES` too high; it may overwhelm target job sources and your VPS.

### VPS Resource Footprint

- The API is a lightweight Node.js process with minimal memory footprint.
- The fetcher daemon runs on a schedule and is generally idle between cycles.
- Monitor disk usage: `LOG_DIR` and `CACHE_DIR` grow over time. Implement log rotation if needed.

### Graceful Shutdown

- `map-rezi-api` and `map-rezi-fetcher` are managed by systemd with `Restart=always`.
- On systemd restart, in-flight fetch cycles may be interrupted. The orchestrator handles this via retry logic.

---

## 10. Known Limitations

- Admin user seeding currently has a race if the API and fetcher start concurrently. See [corrections_bugs_backend.md](./corrections_bugs_backend.md); the issue remains open until the seeding operation is made concurrency-safe.
- `npm start` runs the fetcher daemon (`dist/daemon/index.js`), **not** the API. Use `node dist/api/server.js` for the API.
- Cross-origin deployment (frontend and API on different domains) requires explicit CORS and cookie `SameSite`/`Secure` configuration on the backend, which is not yet implemented.
- The fetcher daemon is optional; the API works independently for browsing existing jobs.
