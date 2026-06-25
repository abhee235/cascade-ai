import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadMemory, appendMemory, replaceMemory, forgetMemory, MEMORY_FILE, MEMORY_LOCAL_FILE } from '../src/memory/memoryStore'
import { buildSystemPrompt } from '../src/agent/systemPrompt'

// Isolate user memory ($CASCADE_HOME) so a real ~/.cascade can't leak into these tests.
let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'cascade-home-'))
  process.env.CASCADE_HOME = home
})
afterEach(async () => {
  process.env.CASCADE_HOME = undefined
  await rm(home, { recursive: true, force: true })
})

describe('memoryStore', () => {
  it('loadMemory: empty when no files; project memory wrapped in the OVERRIDE header', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cascade-mem-'))
    try {
      expect(loadMemory(dir)).toBe('')
      await writeFile(join(dir, MEMORY_FILE), '# Cascade memory\n- prefers tabs\n')
      const block = loadMemory(dir)
      expect(block).toMatch(/OVERRIDES defaults/)
      expect(block).toContain('Project memory')
      expect(block).toContain('prefers tabs')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('loadMemory: includes BOTH user and project memory (project listed last)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cascade-mem-'))
    try {
      await mkdir(join(home, '.cascade'), { recursive: true })
      await writeFile(join(home, '.cascade', MEMORY_FILE), 'global fact')
      await writeFile(join(dir, MEMORY_FILE), 'project fact')
      const block = loadMemory(dir)
      expect(block).toContain('User memory')
      expect(block).toContain('global fact')
      expect(block.indexOf('User memory')).toBeLessThan(block.indexOf('Project memory'))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('append / replace / forget edit project memory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cascade-mem-'))
    try {
      const path = appendMemory(dir, 'deploys via make ship')
      expect(path).toBe(join(dir, MEMORY_FILE))
      appendMemory(dir, 'prefers tabs')
      expect(readFileSync(path, 'utf8')).toMatch(/- deploys via make ship[\s\S]*- prefers tabs/)

      expect(replaceMemory(dir, 'prefers tabs', 'prefers spaces').ok).toBe(true)
      expect(readFileSync(path, 'utf8')).toContain('prefers spaces')
      expect(replaceMemory(dir, 'nonexistent', 'x').ok).toBe(false)

      expect(forgetMemory(dir, 'make ship').ok).toBe(true)
      expect(readFileSync(path, 'utf8')).not.toContain('make ship')
      expect(forgetMemory(dir, 'nonexistent').ok).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('@import inlines a referenced file (and project-local CASCADE.local.md is loaded)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cascade-mem-'))
    try {
      await writeFile(join(dir, 'conventions.md'), '- use 2-space indent')
      await writeFile(join(dir, MEMORY_FILE), '# Project\n@./conventions.md\n')
      await writeFile(join(dir, MEMORY_LOCAL_FILE), '- personal: dark mode')
      const block = loadMemory(dir)
      expect(block).toContain('use 2-space indent') // @import inlined
      expect(block).toContain('Local memory') // .local.md picked up
      expect(block).toContain('dark mode')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('buildSystemPrompt injects proactively-recalled memories (only when present)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cascade-mem-'))
    try {
      expect(buildSystemPrompt({ cwd: dir })).not.toMatch(/Possibly relevant memories/)
      const withRecall = buildSystemPrompt({ cwd: dir, recalled: '- we deploy with make ship' })
      expect(withRecall).toMatch(/Possibly relevant memories/)
      expect(withRecall).toContain('make ship')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('@import is depth/whitelist/circular-safe', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cascade-mem-'))
    try {
      // circular: a imports b imports a
      await writeFile(join(dir, 'a.md'), 'A @./b.md')
      await writeFile(join(dir, 'b.md'), 'B @./a.md')
      await writeFile(join(dir, MEMORY_FILE), '@./a.md')
      const block = loadMemory(dir)
      expect(block).toContain('A')
      expect(block).toContain('B')
      expect(block).toMatch(/circular import/)
      // a bare @handle (no whitelisted extension) is left untouched
      await writeFile(join(dir, MEMORY_FILE), 'ping @someone please')
      expect(loadMemory(dir)).toContain('@someone')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
