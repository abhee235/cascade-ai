import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gatherProjectContext } from '../src/agent/projectContext'
import { buildSystemPrompt } from '../src/agent/systemPrompt'
import { memoryFiles } from '../src/memory/memoryStore'

function seed(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ctx-'))
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }
  return dir
}

describe('gatherProjectContext — directory tree (ADR-046)', () => {
  it('lists the project files, skipping node_modules / dist / .git', async () => {
    const dir = seed({
      'package.json': '{}',
      'src/App.tsx': 'x',
      'src/main.tsx': 'x',
      'node_modules/lib/index.js': 'x',
      'dist/bundle.js': 'x',
      '.git/HEAD': 'ref',
    })
    const ctx = await gatherProjectContext({ cwd: dir, tier: 'full' })
    expect(ctx).toContain('# Project files')
    expect(ctx).toContain('App.tsx')
    expect(ctx).toContain('main.tsx')
    expect(ctx).toContain('package.json')
    expect(ctx).toContain('src/') // directories are marked with a trailing slash
    expect(ctx).not.toContain('node_modules') // dependency dir skipped
    expect(ctx).not.toContain('bundle.js') // build dir skipped
    rmSync(dir, { recursive: true, force: true })
  })

  it('respects the tier depth cap (minimal = depth 2, so depth-3 files are hidden)', async () => {
    const dir = seed({ 'a/b/c/deep.txt': 'x', 'top.txt': 'x' })
    const min = await gatherProjectContext({ cwd: dir, tier: 'minimal' })
    expect(min).toContain('top.txt')
    expect(min).toContain('a/') // depth 1
    expect(min).not.toContain('deep.txt') // depth 3 — beyond the minimal cap of 2
    const full = await gatherProjectContext({ cwd: dir, tier: 'full' })
    expect(full).toContain('deep.txt') // full reaches depth 4
    rmSync(dir, { recursive: true, force: true })
  })

  it('marks truncation when the entry cap is exceeded', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 60; i++) files[`f${i}.txt`] = 'x' // > minimal cap (40)
    const dir = seed(files)
    const min = await gatherProjectContext({ cwd: dir, tier: 'minimal' })
    expect(min).toMatch(/more files omitted/)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('gatherProjectContext — git status (ADR-046)', () => {
  it('omits the git block for a non-repo', async () => {
    const dir = seed({ 'a.txt': 'x' })
    const ctx = await gatherProjectContext({ cwd: dir, tier: 'full' })
    expect(ctx).not.toContain('# Git status')
    rmSync(dir, { recursive: true, force: true })
  })

  it('includes branch + status + recent commits for a real repo', async () => {
    const dir = seed({ 'committed.txt': 'v1', 'untracked.txt': 'new' })
    const git = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
    git(['init', '-q'])
    git(['config', 'user.email', 't@t.dev'])
    git(['config', 'user.name', 'T'])
    git(['add', 'committed.txt'])
    git(['commit', '-qm', 'seed commit'])
    // untracked.txt stays uncommitted → should show in `status --short`
    const ctx = await gatherProjectContext({ cwd: dir, tier: 'full' })
    expect(ctx).toContain('# Git status')
    expect(ctx).toContain('Current branch:')
    expect(ctx).toContain('Recent commits:')
    expect(ctx).toContain('seed commit') // from git log --oneline
    expect(ctx).toContain('untracked.txt') // from git status --short
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('buildSystemPrompt — projectContext injection (ADR-046)', () => {
  const block = '# Project files\nsrc/App.tsx'
  it('appends the project context for the main agent', () => {
    const p = buildSystemPrompt({ cwd: '/p', tier: 'full', projectContext: block })
    expect(p).toContain('# Project files')
    expect(p).toContain('src/App.tsx')
  })
  it('omits it for a subagent (focused task, not the whole tree)', () => {
    const p = buildSystemPrompt({ cwd: '/p', tier: 'full', subagent: true, projectContext: block })
    expect(p).not.toContain('# Project files')
  })
})

describe('memoryFiles — AGENTS.md interop (ADR-046)', () => {
  it('reads AGENTS.md alongside CASCADE.md', () => {
    const names = memoryFiles('/proj').map((f) => f.path)
    expect(names.some((p) => p.endsWith('AGENTS.md'))).toBe(true)
    expect(names.some((p) => p.endsWith('CASCADE.md'))).toBe(true)
  })
})
