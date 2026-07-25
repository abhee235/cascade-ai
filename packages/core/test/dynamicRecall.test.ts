// ADR-074 — dynamic archival recall. The tail-injection + dedup + throttle logic is what keeps recall cache-safe
// and noise-free; these lock the pure parts (query extraction, one-shot surfacing, throttle) without embeddings.

import { describe, expect, it } from 'vitest'
import { buildRecallReminder, recallForTurn, recentFocusText, selectNewRecall } from '../src/agent/dynamicRecall'
import type { ArchivalHit, ArchivalMemory } from '../src/memory/archival'
import type { Message } from '../src/protocol'

const asst = (text: string): Message => ({ role: 'assistant', content: [{ type: 'text', text }] })
const user = (text: string): Message => ({ role: 'user', content: text })
const toolResult = (): Message => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'FILE BLOB '.repeat(500) }] })

describe('recentFocusText — the search query is the model’s current INTENT, not tool blobs', () => {
  it('prefers the most recent assistant text and stops at one assistant turn', () => {
    const msgs = [user('build a shop'), asst('wiring the CTA button colour'), toolResult()]
    expect(recentFocusText(msgs)).toBe('wiring the CTA button colour')
  })
  it('skips a trailing tool_result-only message (no text blocks) and caps length', () => {
    const q = recentFocusText([asst('x'.repeat(2000)), toolResult()], 600)
    expect(q.length).toBe(600) // capped
    expect(q).not.toContain('FILE BLOB') // the blob never enters the query
  })
  it('empty when there is no assistant/user text to focus on', () => {
    expect(recentFocusText([toolResult()])).toBe('')
  })
})

describe('selectNewRecall — surface strong hits exactly once', () => {
  it('drops sub-threshold hits and keeps strong ones', () => {
    const surfaced = new Set<string>()
    const out = selectNewRecall([{ text: 'CTA colour = theme.primary', score: 0.7 }, { text: 'weak', score: 0.4 }], surfaced)
    expect(out).toEqual(['CTA colour = theme.primary'])
  })
  it('never re-surfaces a fact already injected this session', () => {
    const surfaced = new Set<string>()
    const hits = [{ text: 'fact A', score: 0.9 }]
    expect(selectNewRecall(hits, surfaced)).toEqual(['fact A'])
    expect(selectNewRecall(hits, surfaced)).toEqual([]) // second turn — already surfaced
  })
})

describe('buildRecallReminder — framed as recall to VERIFY, not an order to obey', () => {
  it('lists facts and tells the model to check them against current code', () => {
    const r = buildRecallReminder(['fact A', 'fact B'])
    expect(r).toContain('- fact A')
    expect(r).toContain('- fact B')
    expect(r.toLowerCase()).toContain('verify')
  })
})

describe('recallForTurn — throttle + empty-store guards', () => {
  const stubArchival = (hits: ArchivalHit[], count = 1): ArchivalMemory => ({
    add: async () => {},
    search: async () => hits,
    count: () => count,
    list: () => [],
    remove: () => {},
  })

  it('returns null (no embed) when the focus is unchanged since last search', async () => {
    let searched = 0
    const a = stubArchival([{ text: 'f', score: 0.9 }])
    a.search = async () => { searched++; return [{ text: 'f', score: 0.9 }] }
    expect(await recallForTurn({ archival: a, query: 'same', surfaced: new Set(), lastQuery: 'same' })).toBeNull()
    expect(searched).toBe(0) // throttled — never hit the embedder
  })

  it('returns null when the store is empty', async () => {
    expect(await recallForTurn({ archival: stubArchival([], 0), query: 'q', surfaced: new Set() })).toBeNull()
  })

  it('returns a reminder for a fresh strong hit', async () => {
    const r = await recallForTurn({ archival: stubArchival([{ text: 'CTA = theme', score: 0.8 }]), query: 'cta colour', surfaced: new Set() })
    expect(r).toContain('CTA = theme')
  })
})
