#!/usr/bin/env node
// Custom commit message generator for the map-rezi project.
// Uses Kilo CLI to propose a commit message following the project's EBNF format,
// asks for user confirmation, then commits via git.
//
// Usage:
//   git add <files>
//   npm run commit:generate
//
// The generated message is validated by .githooks/commit-msg before the commit
// is finalized, so non-conforming messages are rejected.

const { execFileSync } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const { createInterface } = require('node:readline/promises')

const DIFF_FILE = '/tmp/kilo-commit-diff.txt'

// Model used for commit generation. Defaults to Kilo's free router (no credits
// required). Override per-run with the KILO_MODEL env var, e.g.:
//   KILO_MODEL=kilo/anthropic/claude-haiku-4.5 npm run commit:generate
//   KILO_MODEL=ollama/qwen2.5-coder:7b npm run commit:generate
const KILO_MODEL = process.env.KILO_MODEL || 'kilo/kilo-auto/free'

function ensureKiloInPath() {
  try {
    const globalPrefix = require('child_process')
      .execSync('npm config get prefix', { encoding: 'utf8' })
      .trim()
    const globalBin = `${globalPrefix}/bin`
    const paths = process.env.PATH.split(':')
    if (!paths.includes(globalBin)) {
      process.env.PATH = `${globalBin}:${process.env.PATH}`
    }
    // Verify kilo is now findable
    require('child_process').execSync('which kilo', { encoding: 'utf8', stdio: 'pipe' })
  } catch (_) {
    // If which fails, try npx fallback below
    process.env.KILO_VIA_NPX = '1'
  }
}

function run(cmd, args, { input = null } = {}) {
  const opts = input
    ? { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], input }
    : { encoding: 'utf8', stdio: 'pipe' }
  return execFileSync(cmd, args, opts).trim()
}

function runKilo(prompt, diffFile) {
  // kilo run emits NDJSON events (one JSON object per line). The --file option
  // is an array and greedily consumes the following positional argument, so the
  // prompt MUST come before the flags. --format json returns one JSON event per
  // line; we collect the text parts to build the final message.
  const viaNpx = process.env.KILO_VIA_NPX === '1'
  const baseArgs = viaNpx ? ['--package', '@kilocode/cli', 'kilo'] : []
  const args = [
    ...baseArgs,
    'run',
    prompt,
    '--auto',
    '--format', 'json',
    '--file', diffFile,
    '--model', KILO_MODEL,
  ]
  const cmd = viaNpx ? 'npx' : 'kilo'
  const raw = run(cmd, args)

  let message = ''
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const obj = JSON.parse(trimmed)
      if (obj.type === 'text' && obj.part && obj.part.text) {
        message += obj.part.text
      } else if (obj.type === 'text' && obj.text) {
        message += obj.text
      } else if (typeof obj.text === 'string') {
        message += obj.text
      }
    } catch (_) {
      // Not a JSON event line — ignore (e.g. stray log lines)
    }
  }
  return message.trim() || raw.trim()
}

function getCurrentBranch() {
  return run('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
}

function hasStagedChanges() {
  try {
    run('git', ['diff', '--cached', '--quiet'])
    return false // exit 0 => no staged changes
  } catch (err) {
    return true // exit 1 => staged changes exist
  }
}

function getStagedDiff() {
  return run('git', ['diff', '--cached'])
}

function buildPrompt() {
  return `Generate a commit message following this exact format:

commit-message = keyword "(" main-area [ "/" sub-area ] ")": message
keyword = "feat" | "fix" | "refactor" | "docs" | "test" | "chore"

Rules:
- You MUST include the main area in parentheses after the keyword.
- The sub-area is optional.
- Use imperative mood ("add" not "added").
- Keep subject under 50 characters.
- No trailing period on subject line.
- For breaking changes, add "!" after the scope.

Allowed keywords: feat, fix, refactor, docs, test, chore
Main areas (backend): api, orchestrator, persistence, database, config, daemon, sources, transform, middleware, utils, types

Return ONLY the commit message, nothing else.`
}

async function confirm(prompt) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question(prompt)
  rl.close()
  return answer.trim()
}

async function main() {
  ensureKiloInPath()
  const branch = getCurrentBranch()
  if (branch === 'master') {
    console.warn('WARNING: You are on master branch. Direct commits to master are discouraged.')
    console.warn('Consider creating a feature branch and using a pull request instead.')
    const proceed = await confirm('Continue committing to master? (y/N): ')
    if (proceed.toLowerCase() !== 'y') {
      console.log('Aborted.')
      process.exit(0)
    }
  }

  if (!hasStagedChanges()) {
    console.log('No staged changes. Stage files first with: git add <files>')
    process.exit(1)
  }

  const diff = getStagedDiff()
  writeFileSync(DIFF_FILE, diff)

  console.log('Generating commit message with Kilo CLI...')
  const prompt = buildPrompt()
  let proposedMessage
  try {
    proposedMessage = runKilo(prompt, DIFF_FILE)
  } catch (err) {
    // Surface the real Kilo error instead of a misleading "not installed" hint.
    const msg = (err && err.message) ? err.message : String(err)
    console.error('Failed to run Kilo CLI:', msg)
    console.error('Ensure @kilocode/cli is installed: npm install -g @kilocode/cli')
    process.exit(1)
  }

  if (!proposedMessage) {
    console.error('Kilo CLI returned no message.')
    process.exit(1)
  }

  // Strip markdown code fences if Kilo wrapped the output
  proposedMessage = proposedMessage.replace(/```/g, '').trim()

  console.log('\n--- Proposed commit message ---')
  console.log(proposedMessage)
  console.log('-------------------------------\n')

  const accept = await confirm('Accept this commit message? (y/n/M - modify): ')
  const choice = accept.toLowerCase()

  if (choice === 'm') {
    console.log('\nCurrent message (press Enter to keep, or type a replacement):')
    console.log(proposedMessage)
    console.log('')
    const modified = await confirm('Edit commit message: ')
    const finalMessage = modified.trim() ? modified : proposedMessage
    console.log('\n--- Revised commit message ---')
    console.log(finalMessage)
    console.log('-------------------------------\n')
    const confirmAccept = await confirm('Commit with this message? (Y/n): ')
    if (confirmAccept.toLowerCase() === 'n') {
      console.log('Aborted.')
      process.exit(0)
    }
    run('git', ['commit', '-m', finalMessage])
    console.log('Commit created.')
    return
  }

  if (choice !== 'y') {
    console.log('Aborted.')
    process.exit(0)
  }

  run('git', ['commit', '-m', proposedMessage])
  console.log('Commit created.')
}

main().catch((err) => {
  console.error(err.message || err)
  process.exit(1)
})