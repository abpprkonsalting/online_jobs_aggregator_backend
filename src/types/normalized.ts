import { RowDataPacket } from 'mysql2'

export type UUID = string

export interface GeographicAreaDefinition {
  bbox: [number, number, number, number]
  zoom: number
}

export interface GeographicArea {
  id: UUID
  name: string
  definition: GeographicAreaDefinition
  enabled: boolean
  created_at: Date
  updated_at: Date
}

export interface SourceConfig {
  type: 'api' | 'scrape' | 'hybrid'
  interval_ms?: number
  cron?: string
  api_delay?: number
  retry?: {
    max_attempts?: number
    backoff?: 'fixed' | 'exponential'
  }
  max_tiles?: number
  [key: string]: unknown
}

export interface Source {
  id: UUID
  name: string
  type: 'api' | 'scrape' | 'hybrid'
  config: SourceConfig
  enabled: boolean
  last_run_at: Date | null
  next_run_at: Date | null
  created_at: Date
  updated_at: Date
}

export interface SourceGeographicArea {
  source_id: UUID
  geographic_area_id: UUID
  enabled: boolean
  last_run_at: Date | null
  next_run_at: Date | null
  created_at: Date
  updated_at: Date
}

export interface FetchRun {
  id: UUID
  source_id: UUID
  status: 'running' | 'success' | 'failed'
  started_at: Date
  finished_at: Date | null
  jobs_found: number
  jobs_saved_new: number
  jobs_saved_updated: number
  error_message: string | null
  metadata: Record<string, unknown> | null
  warnings: string[] | null
  created_at: Date
}

export interface Country {
  id: UUID
  name: string
  code: string | null
  created_at: Date
  updated_at: Date
}

export interface City {
  id: UUID
  country_id: UUID
  name: string
  created_at: Date
  updated_at: Date
}

export interface Location {
  id: UUID
  job_id: UUID
  city_id: UUID | null
  raw_text: string | null
  created_at: Date
  updated_at: Date
}

export interface Skill {
  id: UUID
  name: string
  slug: string
  created_at: Date
  updated_at: Date
}

export interface JobSkill {
  job_id: UUID
  skill_id: UUID
}

export interface Category {
  id: UUID
  name: string
  slug: string
  description: string | null
  created_at: Date
  updated_at: Date
}

export interface JobCategory {
  job_id: UUID
  category_id: UUID
  classification_confidence: number | null
}

export interface Job {
  id: UUID
  source_id: UUID
  external_id: string
  title: string
  organization: string | null
  job_url: string
  description_text: string | null
  allow_remote: boolean | null
  salary_min: number | null
  salary_max: number | null
  salary_currency: string | null
  salary_unit: string | null
  date_posted: Date | null
  posted_at: Date | null
  raw_data: Record<string, unknown> | null
  fetched_at: Date | null
  created_at: Date
  updated_at: Date
}

export interface User {
  id: UUID
  email: string
  password_hash: string
  role: 'admin' | 'user'
  is_active: boolean
  last_login_at: Date | null
  created_at: Date
  updated_at: Date
}

export interface RefreshToken {
  id: UUID
  user_id: UUID
  token_hash: string
  expires_at: Date
  revoked_at: Date | null
  created_at: Date
}

export interface JobDetail extends Job {
  skills: Array<{ id: UUID; name: string; slug: string }>
  categories: Array<{ id: UUID; name: string; slug: string; classification_confidence: number | null }>
  locations: Array<{ id: UUID; city_id: UUID | null; raw_text: string | null }>
  days_waiting: number
}

export type JobListItem = Pick<Job, 'id' | 'source_id' | 'external_id' | 'title' | 'organization' | 'job_url' | 'allow_remote' | 'salary_min' | 'salary_max' | 'salary_currency' | 'salary_unit' | 'date_posted' | 'posted_at' | 'fetched_at'> & {
  skills: Array<{ id: UUID; name: string; slug: string }>
  locations: Array<{ id: UUID; city_id: UUID | null; raw_text: string | null; country_id: UUID | null; city_name: string | null; country_name: string | null }>
}