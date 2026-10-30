import type { AiDedupDriver, DedupJob, Group } from './contract'

export class OpenAiDedupDriver<T extends DedupJob = DedupJob> implements AiDedupDriver<T> {
  constructor(private readonly apiKey: string, private readonly model = 'gpt-4o-mini') {}

  async isDuplicate(jobA: T, jobB: T): Promise<boolean> {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'Decide whether two job listings represent the same real opening. Return JSON only: {"duplicate":boolean}. Same title and organization and same URL is duplicate. Different titles are not duplicates. Otherwise require strong evidence.' },
          { role: 'user', content: JSON.stringify({ jobA, jobB }) },
        ],
      }),
    })
    if (!response.ok) throw new Error(`OpenAI dedup request failed (${response.status})`)
    const result = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
    const content = result.choices?.[0]?.message?.content
    if (!content) throw new Error('OpenAI dedup response was empty')
    const parsed = JSON.parse(content) as { duplicate?: unknown }
    if (typeof parsed.duplicate !== 'boolean') throw new Error('OpenAI dedup response had no boolean duplicate field')
    return parsed.duplicate
  }

  async findDuplicates(jobs: T[]): Promise<Group<T>[]> {
    const parent = jobs.map((_job, index) => index)
    const find = (index: number): number => parent[index] === index ? index : (parent[index] = find(parent[index]))
    for (let left = 0; left < jobs.length; left++) {
      for (let right = left + 1; right < jobs.length; right++) {
        if (await this.isDuplicate(jobs[left], jobs[right])) parent[find(right)] = find(left)
      }
    }
    const clusters = new Map<number, T[]>()
    jobs.forEach((job, index) => {
      const root = find(index)
      clusters.set(root, [...(clusters.get(root) ?? []), job])
    })
    return [...clusters.values()].filter((group) => group.length > 1)
      .map((group) => ({ canonical: group[0], duplicates: group.slice(1) }))
  }
}
