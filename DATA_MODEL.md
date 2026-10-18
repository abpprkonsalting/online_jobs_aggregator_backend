# Data Model Proposal

Based on current data and plan, entities proposed:

## 1. sources
Stores configuration for each pluggable job source.

| Field | Type | Notes |
|---|---|---|
| id | UUID (PK) | |
| name | VARCHAR(100) | Unique (e.g., rezi-map) |
| type | ENUM('api','scrape','hybrid') | |
| config | JSON | Source-specific config (endpoints, rate limits, `interval_ms` or `cron` for per-source schedule, `max_tiles` safety cap, retry, etc.) |
| enabled | TINYINT(1) DEFAULT 1 | |
| last_run_at | DATETIME NULL | When the last fetch cycle started for this source |
| next_run_at | DATETIME NULL | Pre-computed next scheduled run (from `config.interval_ms`); used to skip ticks when not due |
| created_at | DATETIME NOT NULL | |
| updated_at | DATETIME NOT NULL | |

## 2. geographic_areas
Standardized geographic area definitions. For phase 1, the standard definition matches Rezi's tile-based approach: a bounding box (bbox) and zoom level. Each source adapter implements conversion from this standard to its native format (other sources may translate bbox+zoom to their own params).

| Field | Type | Notes |
|---|---|---|
| id | UUID (PK) | |
| name | VARCHAR(150) | Human-readable name (e.g., "San Francisco Bay Area") |
| definition | JSON | Standard definition: {bbox: [min_lon, min_lat, max_lon, max_lat], zoom: integer} |
| enabled | TINYINT(1) DEFAULT 1 | |
| created_at | DATETIME NOT NULL | |
| updated_at | DATETIME NOT NULL | |

## 3. source_geographic_areas
Many-to-many relation linking sources to the geographic areas they should fetch. Each row is an enabled fetch configuration for one (source, area) pair.

| Field | Type | Notes |
|---|---|---|
| source_id | UUID (FK → sources.id) NOT NULL | |
| geographic_area_id | UUID (FK → geographic_areas.id) NOT NULL | |
| enabled | TINYINT(1) DEFAULT 1 | Whether this (source, area) combination is actively fetched |
| last_run_at | DATETIME NULL | When the last fetch for this (source, area) started |
| next_run_at | DATETIME NULL | Pre-computed next scheduled run for this (source, area) |
| created_at | DATETIME NOT NULL | |
| updated_at | DATETIME NOT NULL | |
| PRIMARY KEY (source_id, geographic_area_id) | | |

## 4. fetch_runs
Track daemon runs per source.

| Field | Type | Notes |
|---|---|---|
| id | UUID (PK) | |
| source_id | UUID (FK → sources.id) | |
| status | ENUM('running','success','failed') NOT NULL | |
| started_at | DATETIME NOT NULL | |
| finished_at | DATETIME NULL | |
| jobs_found | INT DEFAULT 0 | Jobs returned by source |
| jobs_saved_new | INT DEFAULT 0 | New jobs inserted |
| jobs_saved_updated | INT DEFAULT 0 | Existing jobs updated |
| error_message | TEXT NULL | Error details if failed |
| metadata | JSON NULL | Source-specific run metadata (e.g., tiles/ids/batches for Rezi; metrics for scraping) to avoid losing data without polluting core fields |
| warnings | JSON NULL | Warnings from adapter execution (e.g., batch failures, non-fatal issues) |
| created_at | DATETIME NOT NULL | |

## 5. countries
Country reference table.

| Field | Type | Notes |
|---|---|---|
| id | UUID (PK) | |
| name | VARCHAR(150) | |
| code | VARCHAR(10) | ISO-like code if available |
| created_at | DATETIME NOT NULL | |
| updated_at | DATETIME NOT NULL | |

## 6. cities
City reference table.

| Field | Type | Notes |
|---|---|---|
| id | UUID (PK) | |
| country_id | UUID (FK → countries.id) NOT NULL | City belongs to a country |
| name | VARCHAR(150) | |
| created_at | DATETIME NOT NULL | |
| updated_at | DATETIME NOT NULL | |

## 7. locations
Structured location for jobs (normalized).

| Field | Type | Notes |
|---|---|---|
| id | UUID (PK) | |
| job_id | UUID (FK → jobs.id) NOT NULL | |
| city_id | UUID (FK → cities.id) NULL | |
| raw_text | VARCHAR(255) NULL | Original location string from source |
| created_at | DATETIME NOT NULL | |
| updated_at | DATETIME NOT NULL | |

## 8. skills
Skill reference table (normalized for efficient querying).

| Field | Type | Notes |
|---|---|---|
| id | UUID (PK) | |
| name | VARCHAR(100) NOT NULL | Normalized skill name (e.g., Python, JavaScript) |
| slug | VARCHAR(100) NOT NULL UNIQUE | |
| created_at | DATETIME NOT NULL | |
| updated_at | DATETIME NOT NULL | |

## 9. job_skills
Pivot table linking jobs and skills.

| Field | Type | Notes |
|---|---|---|
| job_id | UUID (FK → jobs.id) NOT NULL | |
| skill_id | UUID (FK → skills.id) NOT NULL | |
| PRIMARY KEY (job_id, skill_id) | | |

## 10. categories
Job categories for classification (many-to-many with jobs).

| Field | Type | Notes |
|---|---|---|
| id | UUID (PK) | |
| name | VARCHAR(100) NOT NULL | e.g., programming, data, devops |
| slug | VARCHAR(100) NOT NULL UNIQUE | |
| description | TEXT NULL | |
| created_at | DATETIME NOT NULL | |
| updated_at | DATETIME NOT NULL | |

## 11. job_categories
Pivot table linking jobs and categories.

| Field | Type | Notes |
|---|---|---|
| job_id | UUID (FK → jobs.id) NOT NULL | |
| category_id | UUID (FK → categories.id) NOT NULL | |
| classification_confidence | DECIMAL(3,2) NULL | Confidence for this classification |
| PRIMARY KEY (job_id, category_id) | | |

## 12. jobs (normalized)
Core job entity.

| Field | Type | Notes |
|---|---|---|
| id | UUID (PK) | Internal UUID |
| source_id | UUID (FK → sources.id) NOT NULL | Provenance |
| external_id | VARCHAR(100) NOT NULL | Source native ID (e.g., obfuscated_id) |
| title | VARCHAR(500) NOT NULL | |
| organization | VARCHAR(255) NULL | Company/employer |
| job_url | TEXT NOT NULL | Canonical link |
| description_text | LONGTEXT NULL | Full description |
| allow_remote | TINYINT(1) NULL | Inferred by source adapter (e.g. from remote_derived) |
| salary_min | DECIMAL(12,2) NULL | General salary fields |
| salary_max | DECIMAL(12,2) NULL | General salary fields |
| salary_currency | VARCHAR(10) NULL | ISO currency code (e.g., USD) |
| salary_unit | VARCHAR(50) NULL | Period unit (e.g., yearly, weekly, hourly) |
| date_posted | DATETIME NULL | Original posted timestamp |
| posted_at | DATETIME NULL | Normalized posted timestamp |
| raw_data | JSON NULL | Original source data (retained for traceability across sources) |
| fetched_at | DATETIME NULL | When last fetched by daemon |
| created_at | DATETIME NOT NULL | |
| updated_at | DATETIME NOT NULL | |

Constraints/Indexes:
- UNIQUE (source_id, external_id)
- INDEX (posted_at, date_posted)
- INDEX (organization, allow_remote)

*Notes:* `days_waiting` is omitted as it can be computed from `posted_at`/`date_posted`. Skills are stored in normalized form via `job_skills`/`skills` for efficient querying.
