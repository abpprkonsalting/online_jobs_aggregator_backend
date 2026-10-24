import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadVersionMetadata } from '../src/utils/version'

const {
  buildMetadata,
  calculateProposal,
  parseConventionalCommit,
  planRelease,
  assertCleanWorkingTree,
} = require('../scripts/versioning.cjs')

const temporaryDirectories: string[] = []

function createRepository(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'map-rezi-release-test-'))
  temporaryDirectories.push(directory)
  execFileSync('git', ['init', '-q', directory])
  execFileSync('git', ['-C', directory, 'config', 'user.name', 'Versioning Test'])
  execFileSync('git', ['-C', directory, 'config', 'user.email', 'versioning@example.test'])
  return directory
}

function commit(directory: string, subject: string, contents: string): string {
  writeFileSync(path.join(directory, 'tracked.txt'), contents)
  execFileSync('git', ['-C', directory, 'add', 'tracked.txt'])
  execFileSync('git', ['-C', directory, 'commit', '-m', subject])
  return execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('release versioning', () => {
  it('classifies breaking changes above features and fixes', () => {
    expect(parseConventionalCommit('fix(api): correct response')).toMatchObject({
      increment: 'patch',
    })
    expect(parseConventionalCommit('feat(api): add endpoint')).toMatchObject({
      increment: 'minor',
    })
    expect(parseConventionalCommit('feat(api)!: change contract')).toMatchObject({
      increment: 'major',
    })
    expect(parseConventionalCommit('fix(api): change contract', 'BREAKING CHANGE: removed field'))
      .toMatchObject({ increment: 'major' })
    expect(parseConventionalCommit('docs: update guide')).toMatchObject({ increment: null })
  })

  it('chooses the highest release increment and keeps unrelated commits non-triggering', () => {
    const proposal = calculateProposal([
      { subject: 'fix(api): handle empty result' },
      { subject: 'feat(api): expose endpoint' },
      { subject: 'docs: update operations guide' },
    ])
    expect(proposal.increment).toBe('minor')
  })

  it('does not invent a next version when no annotated release baseline exists', () => {
    const directory = createRepository()
    commit(directory, 'feat(api): first feature', 'one')
    commit(directory, 'fix(api): correct behavior', 'two')

    const plan = planRelease(directory)
    expect(plan.latest).toBeNull()
    expect(plan.proposedVersion).toBeNull()
    expect(plan.commits.map((entry: { increment: string | null }) => entry.increment))
      .toEqual(['patch', 'minor'])
  })

  it('refuses deployment metadata generation from a dirty checkout', () => {
    const directory = createRepository()
    commit(directory, 'feat(api): initial feature', 'one')
    writeFileSync(path.join(directory, 'uncommitted.txt'), 'local change')

    expect(() => assertCleanWorkingTree(directory))
      .toThrow('Refusing to generate deployment metadata from a dirty Git checkout.')
  })

  it('calculates the proposal from commits after the nearest annotated SemVer tag', () => {
    const directory = createRepository()
    const releaseCommit = commit(directory, 'feat(api): initial endpoint', 'one')
    execFileSync('git', ['-C', directory, 'tag', '-a', 'v2.3.4', '-m', 'Release v2.3.4', releaseCommit])
    commit(directory, 'fix(api): correct result', 'two')
    commit(directory, 'feat(api): add capability', 'three')

    const plan = planRelease(directory)
    expect(plan.latest.tag).toBe('v2.3.4')
    expect(plan.increment).toBe('minor')
    expect(plan.proposedVersion).toBe('v2.4.0')
    expect(plan.commits).toHaveLength(2)
  })

  it('generates release metadata and a checksum manifest only for an exact tagged commit', () => {
    const directory = createRepository()
    const commitSha = commit(directory, 'fix(api): first fix', 'source')
    execFileSync('git', ['-C', directory, 'tag', '-a', 'v1.0.0', '-m', 'Release v1.0.0', commitSha])
    const dist = path.join(directory, 'dist')
    mkdirSync(dist)
    writeFileSync(path.join(dist, 'server.js'), 'compiled server')
    writeFileSync(path.join(directory, '.gitignore'), 'dist/\n')
    const output = path.join(dist, 'version.json')

    const metadata = buildMetadata(directory, output, {
      environment: 'production',
      deploymentId: 'run-123.2',
    })
    expect(metadata).toMatchObject({
      releaseTag: 'v1.0.0',
      buildStatus: 'release',
      commitSha,
      environment: 'production',
      deploymentId: 'run-123.2',
    })
    expect(metadata.artifactSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual(metadata)
    expect(readFileSync(path.join(dist, 'manifest.sha256'), 'utf8')).toContain('server.js')
    expect(loadVersionMetadata(dist, 'production')).toEqual(metadata)

    const taggedMetadata = buildMetadata(directory, output, {
      environment: 'production',
      deploymentId: 'run-123.3',
      workflowRefType: 'tag',
      workflowRefName: 'v1.0.0',
    })
    expect(taggedMetadata).toMatchObject({
      releaseTag: 'v1.0.0',
      buildStatus: 'release',
      commitSha,
    })

    expect(() => buildMetadata(directory, output, {
      environment: 'production',
      deploymentId: 'run-123.4',
      workflowRefType: 'tag',
      workflowRefName: 'v1.0.1',
    })).toThrow('Deployment tag v1.0.1 is not an annotated SemVer release tag for this commit.')

    writeFileSync(path.join(dist, 'server.js'), 'modified server')
    expect(() => loadVersionMetadata(dist, 'production'))
      .toThrow('Deployed artifact checksum mismatch for server.js.')
  })
})
