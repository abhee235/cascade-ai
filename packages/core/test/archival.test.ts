import { describe, it, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createArchival, type Embed } from '../src/memory/archival'

// A toy deterministic embedder: 3 dims keyed on topic words, so cosine ranking is predictable + offline.
const fakeEmbed: Embed = async (texts) =>
  texts.map((t) => {
    const l = t.toLowerCase()
    return [l.includes('deploy') ? 1 : 0, l.includes('test') ? 1 : 0, l.includes('color') || l.includes('theme') ? 1 : 0]
  })

describe('archival memory', () => {
  it('semantic search ranks the relevant fact first', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cascade-arch-'))
    try {
      const a = createArchival({ cwd: dir, embed: fakeEmbed })
      await a.write('deploy with make ship')
      await a.write('run tests via vitest')
      await a.write('the theme color is teal')
      expect(a.count()).toBe(3)

      const hits = await a.search('how do I deploy?', 2)
      expect(hits[0].text).toBe('deploy with make ship')
      expect(hits[0].score).toBeGreaterThan(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('persists across instances (reloads from .cascade/archival.json)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cascade-arch-'))
    try {
      const a1 = createArchival({ cwd: dir, embed: fakeEmbed })
      await a1.write('deploy with make ship')
      const a2 = createArchival({ cwd: dir, embed: fakeEmbed }) // fresh instance, same cwd
      expect(a2.count()).toBe(1)
      expect((await a2.search('deploy', 1))[0].text).toBe('deploy with make ship')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('degrades to keyword (token-overlap) search for natural-language queries when no embedder', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cascade-arch-'))
    try {
      const a = createArchival({ cwd: dir }) // no embed
      await a.write('deploy with make ship')
      await a.write('the theme color is teal')
      const hits = await a.search('how to deploy the app', 5) // NL query, not a substring of any entry
      expect(hits[0].text).toContain('make ship')
      expect(hits[0].score).toBeGreaterThanOrEqual(0.45)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('dedups exact repeats', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cascade-arch-'))
    try {
      const a = createArchival({ cwd: dir })
      await a.write('prefers tabs')
      await a.write('prefers tabs')
      await a.write('  prefers tabs  ')
      expect(a.count()).toBe(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
