import { describe, it, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAgentLoop } from '../src/agent/agentLoop'
import { createArchival, type Embed } from '../src/memory/archival'
import { OpenAICompatProvider } from '../src/llm/providers/openaiCompat'
import { createFakeProvider, textDelta, toolUse, done } from './fakeProvider'
import type { ActivityEvent, Message } from '../src/protocol'

// Toy deterministic embedder (3 topic dims) so cosine ranking is predictable offline.
const fakeEmbed: Embed = async (texts) =>
  texts.map((t) => {
    const l = t.toLowerCase()
    return [l.includes('deploy') || l.includes('ship') ? 1 : 0, l.includes('test') ? 1 : 0, l.includes('color') || l.includes('theme') ? 1 : 0]
  })

// Bypass permissions so write tools (Memory) run without a prompt in the loop.
const bypass = { state: { mode: 'bypass' as const, allow: new Set<string>(), deny: new Set<string>() }, request: async () => 'allow' as const }

async function collect(gen: AsyncIterable<ActivityEvent>): Promise<ActivityEvent[]> {
  const out: ActivityEvent[] = []
  for await (const e of gen) out.push(e)
  return out
}

describe('memory — end-to-end through the agent loop', () => {
  it('Memory tool writes CORE memory, and self-curation writes ARCHIVAL (with a marker)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cascade-int-'))
    try {
      const archival = createArchival({ cwd: dir, embed: fakeEmbed })
      const provider = createFakeProvider([
        [toolUse('m1', 'Memory', { action: 'append', fact: 'prefers tabs over spaces', scope: 'core' }), done('tool_use')],
        [textDelta('Noted.'), done('end_turn')], // terminal → triggers self-curation
        [textDelta('["uses pnpm not npm"]')], // the curation complete() call
      ])
      const msgs: Message[] = [{ role: 'user', content: 'I prefer tabs, and we use pnpm not npm' }]

      const events = await collect(
        runAgentLoop(msgs, { provider, model: 'fake', cwd: dir, signal: new AbortController().signal, permission: bypass, archival, autoMemory: true }),
      )

      // Tier 1: core memory file written via the real executeTool pipeline.
      expect(readFileSync(join(dir, 'CASCADE.md'), 'utf8')).toContain('prefers tabs over spaces')
      // Tier 3: self-curation extracted + archived a durable fact, and surfaced a marker.
      expect(archival.count()).toBe(1)
      expect(events.some((e) => e.type === 'memory' && e.text.includes('pnpm'))).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('MemorySearch retrieves the relevant archived fact (semantic ranking)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cascade-int-'))
    try {
      const archival = createArchival({ cwd: dir, embed: fakeEmbed })
      await archival.write('deploy with make ship')
      await archival.write('the theme color is teal')
      const provider = createFakeProvider([
        [toolUse('s1', 'MemorySearch', { query: 'how do I deploy the app' }), done('tool_use')],
        [textDelta('You deploy with `make ship`.'), done('end_turn')],
        [textDelta('[]')], // curation finds nothing durable
      ])

      const events = await collect(
        runAgentLoop([{ role: 'user', content: 'how do I deploy?' }], {
          provider,
          model: 'fake',
          cwd: dir,
          signal: new AbortController().signal,
          permission: bypass,
          archival,
          autoMemory: true,
        }),
      )

      const results = events.filter((e) => e.type === 'toolResult') as Extract<ActivityEvent, { type: 'toolResult' }>[]
      expect(results.some((e) => e.preview.includes('make ship'))).toBe(true) // top hit, not the teal one
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// Live test against a real Ollama embedding model. Skipped unless CASCADE_LIVE=1 (keeps npm test deterministic).
// Run: CASCADE_LIVE=1 npx vitest run memory.integration   (needs `ollama serve` + the embed model pulled)
const live = process.env.CASCADE_LIVE ? describe : describe.skip
live('memory — LIVE Ollama embeddings', () => {
  it('embeds real text and semantically ranks the right fact first', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cascade-live-'))
    try {
      const provider = new OpenAICompatProvider({ id: 'ollama', baseUrl: 'http://127.0.0.1:11434' })
      const model = process.env.CASCADE_EMBED_MODEL || 'nomic-embed-text'
      const archival = createArchival({ cwd: dir, embed: (texts) => provider.embed!(texts, model) })

      await archival.write('we deploy the app by running make ship')
      await archival.write('the brand accent color is teal')
      await archival.write('run the unit tests with vitest')

      const hits = await archival.search('what command publishes a release?', 1)
      expect(hits[0].text).toContain('make ship')
      expect(hits[0].score).toBeGreaterThan(0.3)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
