import type { Config } from '../config'
import type { AiDedupDriver } from './contract'
import { OpenAiDedupDriver } from './openai-driver'

export function createAiDedupDriver(config: Config): AiDedupDriver | null {
  if (!config.openAiApiKey) return null
  if (config.aiDedupProvider === 'openai') {
    return new OpenAiDedupDriver(config.openAiApiKey, config.aiDedupModel)
  }
  throw new Error(`Unsupported AI_DEDUP_PROVIDER: ${config.aiDedupProvider}`)
}

export type { AiDedupDriver, DedupJob, Group } from './contract'
