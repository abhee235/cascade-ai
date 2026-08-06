// ADR-081 §6: the guarantee that a hosted deployment is a swap, not a fork.
//
// `packages/server` orchestrates; it must not KNOW where state lives. The moment it imports `node:fs`,
// a database driver, or `electron` directly, the Postgres/S3 adapter stops being a drop-in and the
// desktop decision has quietly leaked into the product. This is a TEST rather than a lint rule so it
// fails the suite (there is no biome config at the root to hang a rule on) and so the exemption list
// below is explicit and reviewable — every entry is a file we still owe a port.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC = join(import.meta.dirname, '..', 'src')

// Modules that tie the server to ONE deployment.
const FORBIDDEN = [/from ['"]node:fs['"]/, /from ['"]fs['"]/, /from ['"]better-sqlite3['"]/, /from ['"]electron['"]/, /from ['"]node:sqlite['"]/]

// Files that legitimately touch the filesystem TODAY and are scheduled to move behind a port.
// Shrinking this list is the migration; it must never grow. (ADR-081 implementation order 4–5.)
const PENDING_PORTS = new Set([
  'chatStore.ts', // → ChatStore
  'modelRegistry.ts', // → ConfigStore
  'mcpRegistry.ts', // → ConfigStore
])

// Genuinely deployment-agnostic filesystem use: these operate on the PROJECT's files, which stay real
// files in every deployment (git checkpoints, edits, npm install) and sit behind core's Sandbox port.
const PROJECT_FILES_OK = new Set([
  'projectManager.ts',
  'templates.ts',
  'packTool.ts',
  'previewManager.ts',
  'dockerSandbox.ts',
  'versionManager.ts',
  'checkProject.ts',
  'loadDotEnv.ts',
  'imageSearchTool.ts',
  'browserTool.ts',
  'previewProxy.ts',
  'wsServer.ts',
  'otelTracer.ts',
  'modelCaps.ts',
  'modelSpecs.ts',
  'planStage.ts',
  'visualEdit.ts',
  'fileService.ts', // the project's own file tree — Sandbox-backed, not app state
])

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) out.push(p)
  }
  return out
}

describe('ADR-081 storage boundary', () => {
  it('server does not import fs / a db driver / electron outside the known list', () => {
    const offenders: string[] = []
    for (const file of walk(SRC)) {
      const name = relative(SRC, file).split(/[/\\]/).pop()!
      if (PENDING_PORTS.has(name) || PROJECT_FILES_OK.has(name)) continue
      const src = readFileSync(file, 'utf8')
      if (FORBIDDEN.some((re) => re.test(src))) offenders.push(relative(SRC, file))
    }
    // A new offender means either: put it behind a port, or justify it in one of the sets above.
    expect(offenders).toEqual([])
  })

  it('the pending-port list only names files that still exist (no stale exemptions)', () => {
    const names = new Set(walk(SRC).map((f) => relative(SRC, f).split(/[/\\]/).pop()!))
    for (const p of PENDING_PORTS) expect(names.has(p), `${p} is exempted but no longer exists`).toBe(true)
  })
})
