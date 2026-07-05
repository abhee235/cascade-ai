import { describe, it, expect } from 'vitest'
import {
  collapseSuperseded,
  microcompactToolResults,
  snipLargeToolInputs,
  compactionKindLabel,
  SUPERSEDED_MARKER,
  CLEARED_MARKER,
} from '../src/context/compactionLayers'
import { compactIfNeeded, type CompactionPlan, ALL_COMPACTION_LAYERS } from '../src/context/compactor'
import { createFakeProvider } from './fakeProvider'
import type { ContentBlock, Message } from '../src/protocol'

// Helpers to build tool_use / tool_result exchanges in Cascade's message shape.
const use = (id: string, name: string, input: unknown): Message => ({ role: 'assistant', content: [{ type: 'tool_use', id, name, input } as ContentBlock] })
const res = (id: string, content: string): Message => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content } as ContentBlock] })
const resultContent = (m: Message): string => {
  const r = (m.content as ContentBlock[]).find((b) => b.type === 'tool_result') as Extract<ContentBlock, { type: 'tool_result' }> | undefined
  return r?.content ?? ''
}

describe('layer: collapse (dedupe superseded reads/searches)', () => {
  it('clears the older read of a file that is read again later; keeps the latest', () => {
    const msgs: Message[] = [
      use('r1', 'Read', { file_path: 'a.ts' }),
      res('r1', 'A'.repeat(400)),
      use('r2', 'Read', { file_path: 'a.ts' }),
      res('r2', 'B'.repeat(400)),
    ]
    const out = collapseSuperseded(msgs, 4)
    expect(resultContent(out[1])).toBe(SUPERSEDED_MARKER) // stale earlier read cleared
    expect(resultContent(out[3])).toBe('B'.repeat(400)) // latest read kept
  })

  it('leaves unique reads untouched', () => {
    const msgs: Message[] = [use('r1', 'Read', { file_path: 'a.ts' }), res('r1', 'A'.repeat(400))]
    expect(collapseSuperseded(msgs, 2)).toBe(msgs) // no change → same reference
  })
})

describe('layer: microcompact (evict compactable tool results, keep load-bearing ones)', () => {
  it('clears compactable results but never TodoWrite/Memory results', () => {
    const msgs: Message[] = [
      use('g1', 'Grep', { pattern: 'x' }),
      res('g1', 'grep output'),
      use('t1', 'TodoWrite', { todos: [] }),
      res('t1', 'todos updated'),
    ]
    const out = microcompactToolResults(msgs, 4)
    // Evicted — with a SELF-DESCRIBING stub (delegate-scatter: anonymous stubs read as "nothing happened").
    expect(resultContent(out[1])).toContain(CLEARED_MARKER)
    expect(resultContent(out[1])).toContain('Grep x') // names the tool and its target
    expect(resultContent(out[1])).toContain('Re-run the tool') // and the recovery path
    expect(resultContent(out[3])).toBe('todos updated') // TodoWrite result preserved
  })

  it('does not touch the recent region (idx ≥ olderCount)', () => {
    const msgs: Message[] = [use('g1', 'Grep', { pattern: 'x' }), res('g1', 'grep output')]
    const out = microcompactToolResults(msgs, 0) // nothing is "older"
    expect(resultContent(out[1])).toBe('grep output')
  })
})

describe('self-describing mask stubs (delegate-scatter rung)', () => {
  it('a masked read names the tool, the file, the size, and both recovery paths', async () => {
    const { maskObservations } = await import('../src/context/compactionLayers')
    const msgs: Message[] = [use('r1', 'Read', { file_path: 'src/vault/part3.js' }), res('r1', 'v'.repeat(5000))]
    const out = maskObservations(msgs, 2, 1000)
    const stub = resultContent(out[1])
    expect(stub).toContain('Read src/vault/part3.js')
    expect(stub).toContain('5000 chars')
    expect(stub).toContain('Re-run the tool')
    expect(stub).toContain('Subagent')
    // Idempotent: a described stub is recognized as already-cleared and never re-masked or re-described.
    expect(resultContent(maskObservations(out, 2, 1000)[1])).toBe(stub)
    expect(resultContent(microcompactToolResults(out, 2)[1])).toBe(stub)
  })
})

describe('layer: snip (reclaim large tool INPUTS)', () => {
  it('stubs a large Write input while preserving the record', () => {
    const big = 'x'.repeat(5000)
    const msgs: Message[] = [use('w1', 'Write', { file_path: 'a.ts', content: big }), res('w1', 'ok')]
    const out = snipLargeToolInputs(msgs, 2, 1000)
    const tu = (out[0].content as ContentBlock[])[0] as Extract<ContentBlock, { type: 'tool_use' }>
    expect((tu.input as any)._compacted).toBe(true)
    expect((tu.input as any).note).toContain('a.ts')
    expect(JSON.stringify(tu.input).length).toBeLessThan(1000) // body reclaimed
  })

  it('leaves small inputs and the recent region alone', () => {
    const msgs: Message[] = [use('e1', 'Edit', { file_path: 'a.ts', old_string: 'a', new_string: 'b' }), res('e1', 'ok')]
    expect(snipLargeToolInputs(msgs, 2, 1000)).toBe(msgs) // small input → unchanged reference
  })
})

describe('compactionKindLabel', () => {
  it('maps each kind to a human label', () => {
    expect(compactionKindLabel('collapsed')).toMatch(/superseded/)
    expect(compactionKindLabel('microcompacted')).toMatch(/cleared/)
    expect(compactionKindLabel('snipped')).toMatch(/inputs/)
    expect(compactionKindLabel('summarized')).toMatch(/summarized/)
    expect(compactionKindLabel('weird')).toBe('compacted context')
  })
})

describe('pipeline: cheapest layer that suffices wins (no LLM call)', () => {
  it('collapse alone brings history under threshold ⇒ kind "collapsed", provider untouched', async () => {
    const plan: CompactionPlan = {
      window: 1000,
      effectiveWindow: 1000,
      warn: 150,
      auto: 200,
      hard: 900,
      keepRecentTokens: 40,
      toolResultMaxChars: 2000,
      layers: new Set(ALL_COMPACTION_LAYERS),
      mode: 'layered',
    }
    // r1 (older) is a big read of a.ts, superseded by r2 (recent, tiny). Clearing r1 drops us under auto=200.
    const msgs: Message[] = [
      use('r1', 'Read', { file_path: 'a.ts' }),
      res('r1', 'A'.repeat(1200)), // ~300 tokens, older
      use('r2', 'Read', { file_path: 'a.ts' }),
      res('r2', 'ok'), // recent
      { role: 'user', content: 'what next?' },
    ]
    const provider = createFakeProvider([]) // summarize must NOT run
    const { messages, kind } = await compactIfNeeded(msgs, { provider, model: 'fake', plan })
    expect(kind).toBe('collapsed')
    expect(provider.calls.length).toBe(0)
    expect(resultContent(messages[1])).toBe(SUPERSEDED_MARKER)
  })
})
