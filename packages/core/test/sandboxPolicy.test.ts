// sandboxPolicy.test.ts — ADR-070 step 1: the policy vocabulary (modes, ladder, roots, prompt line).
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalPath, isConfined, renderSandboxPolicy, resolveSandboxMode, writableRoots, SANDBOX_MODES } from '../src/sandbox/policy'
import { buildSystemPrompt } from '../src/agent/systemPrompt'

const ws = mkdtempSync(join(tmpdir(), 'sbxpol-'))

describe('resolveSandboxMode — the ladder (explicit ≻ session ≻ default)', () => {
  it('falls through to the deployment default', () => {
    expect(resolveSandboxMode(undefined, undefined, 'read-only')).toBe('read-only')
  })
  it('a session override outranks the default', () => {
    expect(resolveSandboxMode(undefined, 'workspace-write', 'read-only')).toBe('workspace-write')
  })
  it('an explicit (approved) mode outranks both', () => {
    expect(resolveSandboxMode('danger-full-access', 'workspace-write', 'read-only')).toBe('danger-full-access')
  })
  it('the mode vocabulary is closed and ordered narrowest-first', () => {
    expect(SANDBOX_MODES).toEqual(['read-only', 'workspace-write', 'danger-full-access'])
  })
})

describe('canonicalPath', () => {
  it('resolves an existing path to a real identity (idempotent)', () => {
    const real = canonicalPath(ws)
    expect(canonicalPath(real)).toBe(real)
  })
  it('returns a missing path unchanged — it matches nothing until it exists', () => {
    const missing = join(ws, 'does-not-exist-yet')
    expect(canonicalPath(missing)).toBe(missing)
  })
})

describe('writableRoots — the meaning of each mode', () => {
  it('read-only allows nothing', () => {
    expect(writableRoots({ mode: 'read-only', workspaceRoot: ws })).toEqual([])
  })
  it('workspace-write allows the workspace root plus the temp areas, deduplicated', () => {
    const roots = writableRoots({ mode: 'workspace-write', workspaceRoot: ws })
    expect(roots).toContain(canonicalPath(ws))
    expect(roots).toContain('/tmp')
    expect(roots).toContain(canonicalPath(tmpdir()))
    expect(new Set(roots).size).toBe(roots.length) // no duplicates
  })
  it('a workspace that IS the tmpdir does not appear twice', () => {
    const roots = writableRoots({ mode: 'workspace-write', workspaceRoot: tmpdir() })
    expect(new Set(roots).size).toBe(roots.length)
  })
  it('isConfined: only danger-full-access is unconfined', () => {
    expect(isConfined('read-only')).toBe(true)
    expect(isConfined('workspace-write')).toBe(true)
    expect(isConfined('danger-full-access')).toBe(false)
  })
})

describe('renderSandboxPolicy — one stable line per mode', () => {
  it('names the mode and stays a single line (KV-cache-stable prompt section)', () => {
    for (const mode of SANDBOX_MODES) {
      const line = renderSandboxPolicy({ mode, workspaceRoot: ws })
      expect(line).toContain(mode === 'danger-full-access' ? 'full access' : mode)
      expect(line).not.toContain('\n')
    }
  })
  it('read-only tells the model to attempt tools and follow denial guidance (not self-refuse)', () => {
    expect(renderSandboxPolicy({ mode: 'read-only', workspaceRoot: ws })).toMatch(/attempt the tool normally/i)
  })
})

describe('system prompt policy line (ADR-070)', () => {
  it('renders the line when a policy is supplied — at every tier', () => {
    for (const tier of ['minimal', 'lean', 'full'] as const) {
      const prompt = buildSystemPrompt({ cwd: ws, tier, sandboxPolicy: { mode: 'workspace-write', workspaceRoot: '/workspace' } })
      expect(prompt).toContain('File policy: workspace-write')
    }
  })
  it('omits the line entirely when no policy is supplied — existing frontends keep byte-identical prompts', () => {
    expect(buildSystemPrompt({ cwd: ws })).not.toContain('File policy')
  })
})
