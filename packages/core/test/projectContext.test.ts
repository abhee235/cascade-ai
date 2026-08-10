import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gatherProjectContext } from '../src/agent/projectContext'
import { buildSystemPrompt } from '../src/agent/systemPrompt'
import { loadMemory, memoryFiles } from '../src/memory/memoryStore'

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

describe('memoryFiles — CASCADE.md only, project root only (prompt-audit finding A, 2026-08-11)', () => {
  // The measured poisoning: eval workdirs live INSIDE the Cascade repo, and the old root→cwd ancestor
  // walk + other-agent instruction-file interop fed the repo's own instructions ("do not touch code until the
  // user confirms") to a builder whose next block says the opposite. Cascade reads its OWN file, in the
  // project, full stop — other tools' instruction files are other agents' contracts.
  it('never reads an instruction file that belongs to another tool (AGENTS.md) — only its own CASCADE.md', () => {
    const names = memoryFiles('/proj').map((f) => f.path)

    expect(names.some((p) => p.endsWith('AGENTS.md'))).toBe(false)
    expect(names.some((p) => p.endsWith('CASCADE.md'))).toBe(true)
    expect(names.some((p) => p.endsWith('CASCADE.local.md'))).toBe(true)
  })

  it('never walks above the project root — a nested project inherits nothing from ancestors', () => {
    const files = memoryFiles('/repo/eval/.work/builder-shop-x')
    const projectLevel = files.filter((f) => f.scope !== 'User')
    for (const f of projectLevel) {
      expect(f.path.replaceAll('\\', '/')).toContain('/repo/eval/.work/builder-shop-x/')
    }
    // Exactly one project + one local candidate — no ancestor chain.
    expect(projectLevel.length).toBe(2)
  })

  it('end-to-end: the loaded memory block is CLEAN of ancestor instruction files', () => {
    // The measured wire: 22,837 chars of system prompt, ~6.5k of them a foreign instruction file. Never again.
    const priorHome = process.env.CASCADE_HOME
    process.env.CASCADE_HOME = seed({}) // hermetic: this machine's real user-global memory stays out
    const parent = seed({
      'AGENTS.md': '# Foreign\nTEACH, do not just build. Do not touch code until the user confirms.',
      'CASCADE.md': '# Ancestor cascade memory that must ALSO stay out',
      'proj/PLAN.md': 'x',
    })
    const cwd = join(parent, 'proj')
    const block = loadMemory(cwd)
    expect(block).not.toContain('TEACH')
    expect(block).not.toContain('Ancestor cascade memory')
    // And the project's OWN file still loads.
    writeFileSync(join(cwd, 'CASCADE.md'), 'Always use the premium preset.')
    expect(loadMemory(cwd)).toContain('premium preset')
    if (priorHome === undefined) delete process.env.CASCADE_HOME
    else process.env.CASCADE_HOME = priorHome
  })
})
