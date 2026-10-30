export interface DedupJob {
  id: string
  source_id: string
  external_id: string
  title: string
  organization?: string | null
  job_url: string
}

export interface Group<T> { canonical: T; duplicates: T[] }

export interface AiDedupDriver<T extends DedupJob = DedupJob> {
  isDuplicate(jobA: T, jobB: T): Promise<boolean>
  findDuplicates(jobs: T[]): Promise<Group<T>[]>
}
