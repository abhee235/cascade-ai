import { describe, it, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeProvider, textDelta } from './fakeProvider'
import { createArchival } from '../src/memory/archival'
import { curateMemory, parseFacts } from '../src/memory/curator'

describe('memory self-curation', () => {
  it('parseFacts: strings, {text} objects, embedded JSON, and junk', () => {
    expect(parseFacts('["a","b"]')).toEqual(['a', 'b'])
    expect(parseFacts('noise before [{"text":"x"}] noise after')).toEqual(['x'])
    expect(parseFacts('sorry, no JSON here')).toEqual([])
    expect(parseFacts('[]')).toEqual([])
  })

  it('curateMemory extracts durable facts and writes them to archival', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cascade-cur-'))
    try {
      const provider = createFakeProvider([[textDelta('["prefers tabs over spaces","deploys via make ship"]')]])
      const archival = createArchival({ cwd: dir }) // no embedder → keyword store

      const saved = await curateMemory({
        messages: [{ role: 'user', content: 'btw I prefer tabs, and we deploy via make ship' }],
        provider,
        model: 'fake',
        archival,
      })

      expect(saved).toEqual(['prefers tabs over spaces', 'deploys via make ship'])
      expect(archival.count()).toBe(2)
      expect((await archival.search('tabs', 1))[0].text).toBe('prefers tabs over spaces')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('no archival ⇒ no-op (never throws)', async () => {
    const provider = createFakeProvider([[textDelta('["x"]')]])
    expect(await curateMemory({ messages: [{ role: 'user', content: 'hi' }], provider, model: 'fake' })).toEqual([])
  })
})
