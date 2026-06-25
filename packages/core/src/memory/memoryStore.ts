// memory/memoryStore.ts — durable, cross-session memory (ADR-015). File-backed "core memory" (the MemGPT
// tier): read every session and injected into the system prompt, and crucially it lives OUTSIDE the
// compactable conversation history — so compaction can never erase it. See
// docs/learnings/context-and-memory-design.md.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** Committable project memory; the `.local` variant is personal/gitignored; user is global. */
export const MEMORY_FILE = 'CASCADE.md'
export const MEMORY_LOCAL_FILE = 'CASCADE.local.md'

// Cap the always-injected memory so it can't dominate the (small) context window.
const MAX_LINES = 200
const MAX_BYTES = 25_000

const OVERRIDE_HEADER =
  'The following is durable memory the user saved across sessions. Treat it as standing context and ' +
  'instructions — it OVERRIDES defaults and you MUST follow it.'

/** Where memory lives: user-global, then project. Project is listed last ⇒ higher priority on conflict.
 *  The user dir honors $CASCADE_HOME (lets you relocate global memory, and keeps tests hermetic). */
export function memoryPaths(cwd: string): { user: string; project: string } {
  const home = process.env.CASCADE_HOME || homedir()
  return { user: join(home, '.cascade', MEMORY_FILE), project: join(cwd, MEMORY_FILE) }
}

// ── @import: a memory file can pull in others with `@./rel.md`, `@~/home.md`, `@/abs.md` ──────────────
const IMPORT_EXTS = ['.md', '.markdown', '.txt', '.rules'] // whitelist — never follow @handles or binaries
const MAX_IMPORT_DEPTH = 5
const IMPORT_RE = /@((?:~\/|\/|\.\/|\.\.\/)?[\w.\-/~]+)/g

function resolveImport(spec: string, baseDir: string): string {
  if (spec.startsWith('~/')) return join(homedir(), spec.slice(2))
  if (spec.startsWith('/')) return spec
  return resolve(baseDir, spec)
}

/** Inline `@import`s recursively. Skips code fences, enforces a depth cap + extension whitelist, and a
 *  `seen` set prevents circular imports. Non-whitelisted `@tokens` are left untouched (e.g. @mentions). */
function expandImports(content: string, baseDir: string, depth: number, seen: Set<string>): string {
  if (depth > MAX_IMPORT_DEPTH) return content
  let inFence = false
  return content
    .split('\n')
    .map((line) => {
      if (line.trim().startsWith('```')) {
        inFence = !inFence
        return line
      }
      if (inFence) return line
      return line.replace(IMPORT_RE, (match, spec: string) => {
        if (!IMPORT_EXTS.some((e) => spec.toLowerCase().endsWith(e))) return match // not a memory file
        const path = resolveImport(spec, baseDir)
        if (seen.has(path)) return `[skipped circular import: ${spec}]`
        try {
          const imported = readFileSync(path, 'utf8')
          return `\n${expandImports(imported, dirname(path), depth + 1, new Set([...seen, path]))}\n`
        } catch {
          return `[missing import: ${spec}]`
        }
      })
    })
    .join('\n')
}

function readCapped(path: string): string | undefined {
  try {
    let text = expandImports(readFileSync(path, 'utf8'), dirname(path), 0, new Set([resolve(path)]))
    const lines = text.split('\n')
    if (lines.length > MAX_LINES) text = `${lines.slice(0, MAX_LINES).join('\n')}\n…[memory truncated — keep it concise]`
    if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) text = `${text.slice(0, MAX_BYTES)}\n…[memory truncated]`
    return text.trim() || undefined
  } catch {
    return undefined // missing/unreadable ⇒ no memory from this tier
  }
}

/** Every memory file to load, ordered LOWEST→HIGHEST priority (the model weighs later ones more):
 *  user-global first, then each directory from filesystem-root DOWN to cwd (closer = higher), reading both
 *  the shared `CASCADE.md` and the personal `CASCADE.local.md` at each level. */
export function memoryFiles(cwd: string): { path: string; scope: string }[] {
  const { user } = memoryPaths(cwd)
  const files: { path: string; scope: string }[] = [{ path: user, scope: 'User' }]
  // Ancestor chain root→cwd, so the closest (cwd) is read last (highest priority).
  const dirs: string[] = []
  for (let d = resolve(cwd); ; d = dirname(d)) {
    dirs.push(d)
    if (dirname(d) === d) break
  }
  for (const dir of dirs.reverse()) {
    files.push({ path: join(dir, MEMORY_FILE), scope: 'Project' })
    files.push({ path: join(dir, MEMORY_LOCAL_FILE), scope: 'Local' })
  }
  return files
}

/** The memory block to prepend to the system prompt: all scopes, labeled, under the OVERRIDE header.
 *  Returns '' when there's no memory at all (so the prompt is unchanged). */
export function loadMemory(cwd: string): string {
  const parts: string[] = []
  for (const { path, scope } of memoryFiles(cwd)) {
    const text = readCapped(path)
    if (text) parts.push(`# ${scope} memory (${path})\n${text}`)
  }
  return parts.length ? `${OVERRIDE_HEADER}\n\n${parts.join('\n\n')}` : ''
}

/** Append a durable fact to PROJECT memory (CASCADE.md at the workspace root), creating it if missing.
 *  The agent's self-edit path (MemGPT-style core-memory curation). Returns the file path written. */
export function appendMemory(cwd: string, fact: string): string {
  const { project } = memoryPaths(cwd)
  let existing = ''
  try {
    existing = readFileSync(project, 'utf8')
  } catch {
    /* first write */
  }
  const body = existing.trim() ? existing.trim() : '# Cascade memory'
  mkdirSync(dirname(project), { recursive: true })
  writeFileSync(project, `${body}\n- ${fact.trim()}\n`, 'utf8')
  return project
}

/** Replace the first occurrence of `oldText` with `newText` in project memory. */
export function replaceMemory(cwd: string, oldText: string, newText: string): { ok: boolean; path: string } {
  const { project } = memoryPaths(cwd)
  try {
    const text = readFileSync(project, 'utf8')
    if (!text.includes(oldText)) return { ok: false, path: project }
    writeFileSync(project, text.replace(oldText, newText), 'utf8')
    return { ok: true, path: project }
  } catch {
    return { ok: false, path: project }
  }
}

/** Forget: remove the first memory line containing `text` from project memory. */
export function forgetMemory(cwd: string, text: string): { ok: boolean; path: string } {
  const { project } = memoryPaths(cwd)
  try {
    const lines = readFileSync(project, 'utf8').split('\n')
    const idx = lines.findIndex((l) => l.includes(text))
    if (idx === -1) return { ok: false, path: project }
    lines.splice(idx, 1)
    writeFileSync(project, lines.join('\n'), 'utf8')
    return { ok: true, path: project }
  } catch {
    return { ok: false, path: project }
  }
}
