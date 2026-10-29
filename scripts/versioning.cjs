const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { mkdirSync, readFileSync, readdirSync, writeFileSync } = require('node:fs')
const path = require('node:path')

const SEMVER_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const BREAKING_FOOTER = /^BREAKING CHANGE:\s*\S/m

function parseSemver(tag) {
  const match = SEMVER_TAG.exec(tag)
  return match ? match.slice(1).map(Number) : null
}

function compareSemver(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return 0
}

function parseConventionalCommit(subject, body = '') {
  const match = /^([a-zA-Z][\w-]*)(?:\([^)]+\))?(!)?: .+$/.exec(subject)
  if (!match) return { increment: null, reason: 'not a Conventional Commit' }
  if (match[2] || BREAKING_FOOTER.test(body)) {
    return { increment: 'major', reason: match[2] ? 'breaking ! marker' : 'BREAKING CHANGE footer' }
  }
  if (match[1] === 'feat') return { increment: 'minor', reason: 'feat commit' }
  if (match[1] === 'fix') return { increment: 'patch', reason: 'fix commit' }
  return { increment: null, reason: `${match[1]} does not trigger a release` }
}

function runGit(args, options = {}) {
  return execFileSync('git', args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function getReleaseTags(cwd) {
  const output = runGit([
    'for-each-ref',
    '--format=%(refname:short)%09%(objecttype)%09%(*objectname)',
    'refs/tags',
  ], { cwd })
  if (!output) return []
  return output.split('\n').flatMap((line) => {
    const [tag, objectType, commit] = line.split('\t')
    const version = parseSemver(tag)
    return objectType === 'tag' && version && commit ? [{ tag, version, commit }] : []
  })
}

function isAncestor(cwd, ancestor, commit) {
  try {
    runGit(['merge-base', '--is-ancestor', ancestor, commit], { cwd })
    return true
  } catch (error) {
    if (error.status === 1) return false
    throw error
  }
}

function getCommits(cwd, range) {
  const args = ['log', '--format=%H%x00%s%x00%b%x1e']
  if (range) args.push(`${range}..HEAD`)
  const output = runGit(args, { cwd })
  return output.split('\x1e').flatMap((record) => {
    const trimmed = record.trim()
    if (!trimmed) return []
    const [sha, subject, ...bodyParts] = trimmed.split('\x00')
    return [{ sha, subject, body: bodyParts.join('\x00').trim() }]
  })
}

function calculateProposal(commits) {
  const increments = { patch: 1, minor: 2, major: 3 }
  const classified = commits.map((commit) => ({
    ...commit,
    ...parseConventionalCommit(commit.subject, commit.body),
  }))
  const strongest = classified.reduce((highest, commit) => (
    commit.increment && (!highest || increments[commit.increment] > increments[highest])
      ? commit.increment
      : highest
  ), null)
  return { classified, increment: strongest }
}

function nextVersion(current, increment) {
  const [major, minor, patch] = current
  if (increment === 'major') return `v${major + 1}.0.0`
  if (increment === 'minor') return `v${major}.${minor + 1}.0`
  return `v${major}.${minor}.${patch + 1}`
}

function planRelease(cwd) {
  const head = runGit(['rev-parse', 'HEAD'], { cwd })
  const candidates = getReleaseTags(cwd).filter((tag) => isAncestor(cwd, tag.commit, head))
  for (const tag of candidates) {
    tag.distance = Number(runGit(['rev-list', '--count', `${tag.commit}..${head}`], { cwd }))
  }
  candidates.sort((left, right) =>
    left.distance - right.distance || compareSemver(right.version, left.version),
  )
  const latest = candidates[0] ?? null
  const commits = getCommits(cwd, latest?.commit)
  const proposal = calculateProposal(commits)
  const status = runGit(['status', '--porcelain', '--untracked-files=all'], { cwd })
  return {
    head,
    latest,
    commits: proposal.classified,
    increment: proposal.increment,
    proposedVersion: latest && proposal.increment
      ? nextVersion(latest.version, proposal.increment)
      : null,
    dirty: status.length > 0,
  }
}

function listFiles(directory, relativeTo = directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name)
    return entry.isDirectory()
      ? listFiles(file, relativeTo)
      : [path.relative(relativeTo, file).split(path.sep).join('/')]
  })
}

function hashArtifacts(distDirectory) {
  const excluded = new Set(['version.json', 'manifest.sha256'])
  const files = listFiles(distDirectory)
    .filter((file) => !excluded.has(file))
    .sort()
  if (files.length === 0) throw new Error('Cannot create a version manifest for an empty dist directory')
  const entries = files.map((file) => {
    const digest = createHash('sha256')
      .update(readFileSync(path.join(distDirectory, file)))
      .digest('hex')
    return `${digest}  ${file}`
  })
  writeFileSync(path.join(distDirectory, 'manifest.sha256'), `${entries.join('\n')}\n`)
  return createHash('sha256').update(entries.join('\n')).digest('hex')
}

function buildMetadata(cwd, outputPath, {
  environment = 'unknown',
  deploymentId = null,
  workflowRefType = null,
  workflowRefName = null,
} = {}) {
  const commitSha = runGit(['rev-parse', 'HEAD'], { cwd })
  const exactTags = getReleaseTags(cwd).filter((tag) => tag.commit === commitSha)
  if (exactTags.length > 1) {
    throw new Error(`Commit ${commitSha} has multiple official release tags: ${exactTags.map((tag) => tag.tag).join(', ')}`)
  }
  const releaseTag = exactTags[0]?.tag ?? null
  if (workflowRefType === 'tag' && (releaseTag !== workflowRefName || !releaseTag)) {
    throw new Error(`Deployment tag ${workflowRefName} is not an annotated SemVer release tag for this commit.`)
  }
  const distDirectory = path.dirname(outputPath)
  const artifactSha256 = hashArtifacts(distDirectory)
  const metadata = {
    schemaVersion: 1,
    releaseTag,
    buildStatus: releaseTag ? 'release' : 'untagged',
    commitSha,
    buildTimestampUtc: new Date().toISOString(),
    environment: environment || 'unknown',
    deploymentId,
    artifactSha256,
  }
  mkdirSync(distDirectory, { recursive: true })
  writeFileSync(outputPath, `${JSON.stringify(metadata, null, 2)}\n`)
  return metadata
}

function assertCleanWorkingTree(cwd) {
  const status = runGit(['status', '--porcelain', '--untracked-files=all'], { cwd })
  if (status) {
    throw new Error('Refusing to generate deployment metadata from a dirty Git checkout.')
  }
}

function main() {
  const cwd = process.cwd()
  const mode = process.argv[2]
  if (mode === 'metadata') {
    const outputPath = path.resolve(process.argv[3] ?? 'dist/version.json')
    assertCleanWorkingTree(cwd)
    const metadata = buildMetadata(
      cwd,
      outputPath,
      {
        environment: process.env.DEPLOYMENT_ENVIRONMENT ?? process.env.NODE_ENV ?? 'unknown',
        deploymentId: process.env.GITHUB_RUN_ID
          ? `${process.env.GITHUB_RUN_ID}.${process.env.GITHUB_RUN_ATTEMPT ?? '1'}`
          : null,
        workflowRefType: process.env.GITHUB_REF_TYPE ?? null,
        workflowRefName: process.env.GITHUB_REF_NAME ?? null,
      },
    )
    console.log(JSON.stringify(metadata, null, 2))
    return
  }
  if (mode === 'plan') {
    printPlan(planRelease(cwd))
    return
  }
  if (mode === 'tag') {
    createApprovedTag(cwd, process.argv.slice(3))
    return
  }
  throw new Error('Usage: node scripts/versioning.cjs <metadata|plan|tag>')
}

function printPlan(plan) {
  console.log(`Current commit: ${plan.head}`)
  if (!plan.latest) {
    console.log('No annotated SemVer release tag is reachable from this commit.')
    console.log('A next version cannot be calculated. Choose an initial baseline only after reviewing the full history.')
  } else {
    console.log(`Last release: ${plan.latest.tag} (${plan.latest.commit})`)
    console.log(`Commits since release: ${plan.commits.length}`)
  }
  for (const commit of plan.commits) {
    const classification = commit.increment
      ? `${commit.increment}: ${commit.reason}`
      : `no release: ${commit.reason}`
    console.log(`- ${commit.sha.slice(0, 12)} ${commit.subject} [${classification}]`)
  }
  if (plan.latest && plan.increment) {
    console.log(`Highest increment: ${plan.increment}`)
    console.log(`Proposed version: ${plan.proposedVersion}`)
    console.log('This is a proposal only; no tag has been created or pushed.')
  } else if (plan.latest) {
    console.log('No release-triggering commits found; no version is proposed.')
  }
  if (plan.dirty) {
    console.log('Working tree has changes; an annotated release tag will require a clean working tree.')
  }
}

async function createApprovedTag(cwd, args) {
  const initialIndex = args.indexOf('--initial')
  const initialVersion = initialIndex >= 0 ? args[initialIndex + 1] : null
  const approveIndex = args.indexOf('--approve')
  const approvedVersion = approveIndex >= 0 ? args[approveIndex + 1] : null
  const plan = planRelease(cwd)
  if (plan.dirty) throw new Error('Refusing to tag a dirty working tree. Commit or safely move all changes first.')
  printPlan(plan)

  let version
  if (!plan.latest) {
    if (!initialVersion || !parseSemver(initialVersion)) {
      throw new Error('No release baseline exists. Specify an explicitly reviewed --initial vMAJOR.MINOR.PATCH.')
    }
    version = initialVersion
    console.log('Initial release: no existing tag provides a version baseline.')
    console.log(`All reachable history is associated with the explicitly selected baseline ${version}.`)
  } else {
    if (!plan.proposedVersion) throw new Error('No release-triggering commits exist; there is no version to tag.')
    version = approvedVersion || plan.proposedVersion
    if (!parseSemver(version)) {
      throw new Error(`Invalid version: ${version}. Use vMAJOR.MINOR.PATCH.`)
    }
    if (initialVersion) throw new Error('--initial can only be used when no annotated SemVer release tag exists.')
    if (!approvedVersion) {
      throw new Error(`Explicit approval required: rerun with --approve ${plan.proposedVersion}.`)
    }
    if (approvedVersion !== plan.proposedVersion) {
      console.log(`Warning: overriding proposed version ${plan.proposedVersion} with ${approvedVersion}.`)
    }
  }
  if (runGit(['tag', '--list', version], { cwd })) {
    throw new Error(`Tag ${version} already exists.`)
  }

  console.log(`Release tag: ${version}`)
  console.log(`Target commit: ${plan.head}`)
  console.log('Review the proposal above. Enter the exact tag name to create this annotated tag, or press Ctrl-C to cancel.')
  const { createInterface } = require('node:readline/promises')
  const readline = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const confirmation = await readline.question(`Type ${version} to confirm: `)
    if (confirmation !== version) throw new Error('Confirmation did not match; no tag was created.')
  } finally {
    readline.close()
  }
  runGit(['tag', '-a', version, '-m', `Release ${version}`, plan.head], { cwd })
  console.log(`Created annotated tag ${version} at ${plan.head}.`)
  console.log(`Review and push it explicitly when ready: git push github ${version}`)
}

if (require.main === module) {
  main()
}

module.exports = {
  buildMetadata,
  calculateProposal,
  parseConventionalCommit,
  parseSemver,
  planRelease,
  assertCleanWorkingTree,
}
