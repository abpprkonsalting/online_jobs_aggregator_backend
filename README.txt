# Backend README

## Requirements
- Node.js 20+ (tested with Node 24)
- MySQL 8.0+ running locally or remotely
- npm (for dependency management)

## Setup

1. Install dependencies:
   cd backend && npm install

2. Configure environment:
   cp .env.example .env
   Edit .env and set:
   - DATABASE_URL (e.g. mysql://root:password@localhost:3306/map_rezi)
   - JWT_SECRET (32+ chars)
   - ADMIN_EMAIL, ADMIN_PASSWORD (seeded on first run)

3. Create the database (optional):
   The API server auto-creates the `map_rezi` database and seeds the admin user on startup, so this step is only needed if you want to pre-create it manually:
   mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS map_rezi;"

4. Build:
   npm run build

5. Run:
   node -r dotenv/config dist/api/server.js
   (or for dev: npm run dev -- requires ts-node)

## API Endpoints

### Auth
- POST /api/auth/login { email, password } -> { access_token, user }
- POST /api/auth/refresh (uses httpOnly cookie) -> { access_token }
- POST /api/auth/logout -> { success }
- GET /api/auth/me -> { id, email, role }

### Jobs (public, optional auth)
- GET /api/jobs?limit=&offset=&sort=posted_at&sortDir=desc&category=&skill=&city_id=&country_id=&source_id=&allow_remote=&salary_min=&salary_max=&organization=
- GET /api/jobs/:id -> job detail with skills/categories/locations/days_waiting

### Master tables (admin)
- GET /api/categories, /api/skills, /api/cities, /api/countries
- GET /api/master/schema -> { countries, cities, skills, categories, geographic_areas }
- POST /api/master/seed-skills { skills: [{name, slug}] }
- POST /api/master/seed-cities { cities: [{name, country_id}] }
- POST /api/master/seed-countries { countries: [{name, code}] }
- POST /api/master/seed-categories { categories: [{name, slug, description}] }

### Admin (admin only)
- GET /api/admin/sources
- POST /api/admin/sources { name, type, config, enabled }
- PATCH /api/admin/sources/:id
- DELETE /api/admin/sources/:id
- GET /api/admin/geographic-areas
- POST /api/admin/geographic-areas { name, definition, enabled }
- PUT /api/admin/geographic-areas/:id
- DELETE /api/admin/geographic-areas/:id
- GET /api/admin/areas
- POST /api/admin/areas { source_id, geographic_area_id, enabled }
- DELETE /api/admin/areas/:source_id/:area_id
- GET /api/admin/fetch-runs?source_id=
- GET /api/admin/master/schema

### Users (admin only)
- GET /api/users
- POST /api/users { email, password, role }
- PATCH /api/users/:id { role }
- DELETE /api/users/:id (deactivate)

## Frontend Integration

The frontend should:
1. POST to /api/auth/login with email/password, store access_token in memory or localStorage.
2. Include "Authorization: Bearer <access_token>" header on all protected requests.
3. Use httpOnly refresh_token cookie for /api/auth/refresh.
4. Call GET /api/jobs with query params for filtering/sorting/pagination.
5. Call GET /api/categories, /api/skills, /api/cities, /api/countries for filter dropdowns.
6. Admin users can manage sources, areas, and review fetch runs via /api/admin/*.

## Notes
- days_waiting is computed at query time from posted_at/date_posted.
- Master tables (skills, categories, cities, countries, geographic_areas) are frontend-owned; the fetch pipeline never modifies them.
- The daemon (orchestrator) runs separately; this server only exposes the REST API.