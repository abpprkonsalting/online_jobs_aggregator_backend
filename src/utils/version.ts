import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

export interface VersionMetadata {
  schemaVersion: 1
  releaseTag: string | null
  buildStatus: 'release' | 'untagged' | 'development'
  commitSha: string | null
  buildTimestampUtc: string | null
  environment: string
  deploymentId: string | null
  artifactSha256: string | null
}

const distDirectory = path.resolve(__dirname, '..')
const metadataPath = path.join(distDirectory, 'version.json')

function isVersionMetadata(value: unknown): value is VersionMetadata {
  if (typeof value !== 'object' || value === null) return false
  const metadata = value as Record<string, unknown>
  const releaseTagValid = metadata.releaseTag === null
    ? metadata.buildStatus !== 'release'
    : typeof metadata.releaseTag === 'string'
      && /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(metadata.releaseTag)
      && metadata.buildStatus === 'release'
  return metadata.schemaVersion === 1
    && releaseTagValid
    && ['release', 'untagged'].includes(metadata.buildStatus as string)
    && typeof metadata.commitSha === 'string'
    && /^[a-f0-9]{40}$/.test(metadata.commitSha)
    && (metadata.buildTimestampUtc === null || typeof metadata.buildTimestampUtc === 'string')
    && typeof metadata.environment === 'string'
    && (metadata.deploymentId === null || typeof metadata.deploymentId === 'string')
    && (metadata.artifactSha256 === null || typeof metadata.artifactSha256 === 'string')
}

function listFiles(directory: string, relativeTo = directory): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name)
    return entry.isDirectory()
      ? listFiles(file, relativeTo)
      : [path.relative(relativeTo, file).split(path.sep).join('/')]
  })
}

function verifyArtifactManifest(metadata: VersionMetadata, distDirectory: string): void {
  if (!metadata.artifactSha256) throw new Error('Deployment metadata is missing its artifact checksum.')
  const manifestPath = path.join(distDirectory, 'manifest.sha256')
  const manifest = readFileSync(manifestPath, 'utf8')
  const entries = manifest.trim().split('\n').filter(Boolean)
  const expectedFiles = new Set<string>()
  const canonicalEntries: string[] = []

  for (const entry of entries) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(entry)
    if (!match) throw new Error('Deployment artifact manifest has an invalid entry.')
    const [, expectedDigest, relativeFile] = match
    if (
      path.isAbsolute(relativeFile)
      || relativeFile.split('/').some((part) => part === '..' || part === '.')
      || expectedFiles.has(relativeFile)
    ) {
      throw new Error('Deployment artifact manifest contains an unsafe or duplicate file path.')
    }
    expectedFiles.add(relativeFile)
    canonicalEntries.push(entry)
    const contents = readFileSync(path.join(distDirectory, relativeFile))
    const actualDigest = createHash('sha256').update(contents).digest('hex')
    if (actualDigest !== expectedDigest) {
      throw new Error(`Deployed artifact checksum mismatch for ${relativeFile}.`)
    }
  }

  const actualManifestHash = createHash('sha256').update(canonicalEntries.join('\n')).digest('hex')
  if (actualManifestHash !== metadata.artifactSha256) {
    throw new Error('Deployment artifact manifest does not match version metadata.')
  }

  const actualFiles = new Set(
    listFiles(distDirectory).filter((file) => !['version.json', 'manifest.sha256'].includes(file)),
  )
  if (
    actualFiles.size !== expectedFiles.size
    || [...actualFiles].some((file) => !expectedFiles.has(file))
  ) {
    throw new Error('Deployed artifact files do not match the verified build manifest.')
  }
}

export function loadVersionMetadata(
  distDirectory = path.resolve(__dirname, '..'),
  nodeEnvironment = process.env.NODE_ENV,
): VersionMetadata {
  const metadataPath = path.join(distDirectory, 'version.json')
  let raw: string
  try {
    raw = readFileSync(metadataPath, 'utf8')
  } catch (error) {
    if (
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && error.code === 'ENOENT'
      && nodeEnvironment !== 'production'
    ) {
      const developmentSha = process.env.GIT_COMMIT_SHA ?? null
      return {
        schemaVersion: 1,
        releaseTag: null,
        buildStatus: 'development',
        commitSha: developmentSha && /^[a-f0-9]{40}$/.test(developmentSha)
          ? developmentSha
          : null,
        buildTimestampUtc: null,
        environment: nodeEnvironment ?? 'development',
        deploymentId: null,
        artifactSha256: null,
      }
    }
    throw error
  }

  const parsed: unknown = JSON.parse(raw)
  if (!isVersionMetadata(parsed)) throw new Error('Deployment version metadata has an invalid format.')
  verifyArtifactManifest(parsed, distDirectory)
  return parsed
}

let cachedVersionMetadata: VersionMetadata | null = null

function getVersionMetadata(): VersionMetadata {
  if (!cachedVersionMetadata) cachedVersionMetadata = loadVersionMetadata()
  return cachedVersionMetadata
}

export function publicVersionMetadata(): Omit<VersionMetadata, 'schemaVersion' | 'artifactSha256'> {
  const { schemaVersion: _schemaVersion, artifactSha256: _artifactSha256, ...publicMetadata } = getVersionMetadata()
  return publicMetadata
}

export function versionLogFields(service: string): Record<string, string | null> {
  const metadata = getVersionMetadata()
  return {
    service,
    releaseTag: metadata.releaseTag,
    buildStatus: metadata.buildStatus,
    commitSha: metadata.commitSha,
    deploymentId: metadata.deploymentId,
  }
}
