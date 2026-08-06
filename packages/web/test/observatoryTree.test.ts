// The flat→forest fold decides what a trace LOOKS like, and its edge cases are the ones that show up
// mid-build rather than in a finished trace: a parent not yet flushed, a span still running.
import { describe, it, expect } from 'vitest'
import type { SpanInfo } from '@cascade/app-protocol'
import { buildForest, countDescendants, traceWindow } from '../src/components/observatory/tree'

const span = (o: Partial<SpanInfo> & { spanId: string }): SpanInfo => ({
  traceId: 't1',
  name: o.spanId,
  kind: 'TOOL',
  startedAt: 1000,
  ...o,
})

describe('Observatory span tree (ADR-081)', () => {
  it('nests children under their parent and leaves the root at the top', () => {
    const forest = buildForest([span({ spanId: 'root', kind: 'AGENT' }), span({ spanId: 'a', parentSpanId: 'root' }), span({ spanId: 'b', parentSpanId: 'root' })])
    expect(forest).toHaveLength(1)
    expect(forest[0].span.spanId).toBe('root')
    expect(forest[0].children.map((c) => c.span.spanId)).toEqual(['a', 'b'])
  })

  it('KEEPS an orphan instead of dropping it — a live trace often lacks its parent yet', () => {
    // The root span is written on `submit` but sits in the write buffer; its children can be read first.
    // If the orphan vanished, the page would be blank during exactly the turn you are watching.
    const forest = buildForest([span({ spanId: 'child', parentSpanId: 'not-flushed-yet' })])
    expect(forest.map((n) => n.span.spanId)).toEqual(['child'])
  })

  it('sorts siblings by start time so the tree reads in the order things happened', () => {
    const forest = buildForest([
      span({ spanId: 'root', kind: 'AGENT', startedAt: 0 }),
      span({ spanId: 'late', parentSpanId: 'root', startedAt: 500 }),
      span({ spanId: 'early', parentSpanId: 'root', startedAt: 100 }),
    ])
    expect(forest[0].children.map((c) => c.span.spanId)).toEqual(['early', 'late'])
  })

  it('survives a self-parent (would otherwise recurse forever while rendering)', () => {
    const forest = buildForest([span({ spanId: 'loop', parentSpanId: 'loop' })])
    expect(forest.map((n) => n.span.spanId)).toEqual(['loop'])
    expect(forest[0].children).toHaveLength(0)
  })

  it('survives a mutual-parent cycle', () => {
    const forest = buildForest([span({ spanId: 'a', parentSpanId: 'b' }), span({ spanId: 'b', parentSpanId: 'a' })])
    // Exactly one of them keeps the edge; the other is demoted to a root. Which one is arbitrary — what
    // matters is that both are reachable and the walk terminates.
    expect(forest.length).toBeGreaterThanOrEqual(1)
    const ids = new Set<string>()
    const walk = (n: { span: SpanInfo; children: { span: SpanInfo; children: unknown[] }[] }) => {
      expect(ids.has(n.span.spanId)).toBe(false) // no span rendered twice
      ids.add(n.span.spanId)
      for (const c of n.children) walk(c as never)
    }
    forest.forEach(walk)
    expect([...ids].sort()).toEqual(['a', 'b'])
  })

  it('counts descendants for the collapsed "+N" badge', () => {
    const [root] = buildForest([
      span({ spanId: 'root', kind: 'AGENT' }),
      span({ spanId: 'a', parentSpanId: 'root' }),
      span({ spanId: 'a1', parentSpanId: 'a' }),
      span({ spanId: 'b', parentSpanId: 'root' }),
    ])
    expect(countDescendants(root)).toBe(3)
  })

  it('scales the timeline by MIN start → MAX end, not by the root span', () => {
    // The root commits at turn_done, but a tracer can close a child later; scaling by the root would push
    // that child off the end of every bar.
    const w = traceWindow([span({ spanId: 'root', startedAt: 100, endedAt: 900 }), span({ spanId: 'late', startedAt: 200, endedAt: 1500 })])
    expect(w.start).toBe(100)
    expect(w.ms).toBe(1400)
  })

  it('treats a RUNNING span (no end) as reaching only its start, never negative', () => {
    const w = traceWindow([span({ spanId: 'running', startedAt: 400 })])
    expect(w.start).toBe(400)
    expect(w.ms).toBe(1) // clamped: a zero-width window would divide by zero in the bar
  })

  it('an empty trace does not produce a NaN window', () => {
    expect(traceWindow([])).toEqual({ start: 0, ms: 1 })
  })
})
