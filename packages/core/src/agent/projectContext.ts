// agent/projectContext.ts — gather the project facts a strong model would discover on its own but a weak one
// wastes turns (and hallucinates paths) rediscovering: a bounded DIRECTORY TREE and a GIT STATUS snapshot.
// Gathered ONCE per session (async — git shells out), sized to the window tier, and injected into the system
// prompt so it's always available and never compacted away. — ADR-046 (CORE-PARITY A6).
//
// The project's INSTRUCTIONS file (CASCADE.md) is handled separately by memoryStore.loadMemory —
// this module is only the discovered facts (tree + git). Kept pure + headless (node:* only).

import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { WindowTier } from '../llm/contextWindows'

const execFileP = promisify(execFile)

// Never walk into these — they're bulk the model never needs (and would blow the budget).
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.svelte-kit', '.turbo', '.vite',
  '.cache', '.parcel-cache', '.git', '.cascade', 'vendor', '__pycache__', '.venv', 'target',
])

// How much of a tree each window tier can afford. A weak model needs path-awareness MOST, so even the smallest
// window gets a (small) tree — path hallucination is a top failure mode.
const TREE_CAPS: Record<WindowTier, { entries: number; depth: number }> = {
  full: { entries: 200, depth: 4 },
  lean: { entries: 100, depth: 3 },
  minimal: { entries: 40, depth: 2 },
}

const MAX_STATUS_CHARS = 2_000 // cap `git status`; the model can run `git status` for the rest

/** A compact, indented tree of the project, relative to its root: dirs first then files, bounded by the tier's
 *  entry + depth caps, skipping build/dep dirs and hidden directories. Returns '' for an empty/unreadable dir. */
function buildTree(root: string, tier: WindowTier): string {
  const cap = TREE_CAPS[tier]
  const lines: string[] = []
  let count = 0
  let truncated = false

  const walk = (dir: string, prefix: string, depth: number): void => {
    if (depth > cap.depth) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return // unreadable dir — skip
    }
    // Hide dependency/build dirs and ALL hidden directories (noise); keep hidden files (.gitignore, .env.example).
    const visible = entries.filter((e) => !(e.isDirectory() && (SKIP_DIRS.has(e.name) || e.name.startsWith('.'))))
    // Dirs first, then alphabetical — reads like a file explorer.
    visible.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))
    for (const e of visible) {
      if (count >= cap.entries) {
        truncated = true
        return
      }
      count++
      const isDir = e.isDirectory()
      lines.push(`${prefix}${e.name}${isDir ? '/' : ''}`)
      if (isDir) walk(join(dir, e.name), `${prefix}  `, depth + 1)
    }
  }

  walk(root, '', 1)
  if (!lines.length) return ''
  return lines.join('\n') + (truncated ? '\n… (more files omitted — use Glob to list them)' : '')
}

/** Run one git command in `cwd`, returning trimmed stdout or '' on any failure (not a repo, git missing, slow). */
async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileP('git', args, { cwd, timeout: 5_000, windowsHide: true, maxBuffer: 1 << 20 })
    return stdout.trim()
  } catch {
    return ''
  }
}

/** A git snapshot (branch + short status + recent commits), or null when `cwd` isn't a usable git repo.
 *  Explicitly labelled as a start-of-session snapshot that won't update. */
async function gitStatus(cwd: string): Promise<string | null> {
  if (!existsSync(join(cwd, '.git'))) return null // fast bail for the common non-repo case (scaffolded apps)
  const [branch, status, log] = await Promise.all([
    git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(cwd, ['--no-optional-locks', 'status', '--short']),
    git(cwd, ['--no-optional-locks', 'log', '--oneline', '-n', '5']),
  ])
  if (!branch && !status && !log) return null // git present but unusable — don't inject an empty block
  const shortStatus =
    status.length > MAX_STATUS_CHARS
      ? `${status.slice(0, MAX_STATUS_CHARS)}\n… (truncated — run \`git status\` for the rest)`
      : status
  return [
    'Snapshot at session start — it will NOT update as you work.',
    `Current branch: ${branch || '(unknown)'}`,
    `Status:\n${shortStatus || '(clean)'}`,
    `Recent commits:\n${log || '(none)'}`,
  ].join('\n')
}

/** Gather the injectable project-context block (tree + git), sized to the window tier. Best-effort: any part
 *  that can't be gathered is simply omitted. Returns '' when there's nothing (so the prompt is unchanged). */
export async function gatherProjectContext({ cwd, tier }: { cwd: string; tier: WindowTier }): Promise<string> {
  const parts: string[] = []
  const tree = buildTree(cwd, tier)
  if (tree) {
    parts.push(`# Project files\nRelative to the working directory; a snapshot at session start (use Glob/Read for the current state):\n\n${tree}`)
  }
  const status = await gitStatus(cwd)
  if (status) parts.push(`# Git status\n${status}`)
  return parts.join('\n\n')
}
