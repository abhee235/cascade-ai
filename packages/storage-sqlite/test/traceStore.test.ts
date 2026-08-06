import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/db.js'
import { createTraceStore } from '../src/traceStore.js'

const tmpDb = () => join(mkdtempSync(join(tmpdir(), 'cascade-db-')), 'test.db')

const span = (o: Partial<Parameters<ReturnType<typeof createTraceStore>['record']>[0]> = {}) => ({
  traceId: 't1',
  spanId: `s${Math.random()}`,
  name: 'llm turn 0',
  kind: 'LLM',
  startedAt: 1000,
  endedAt: 1200,
  ...o,
})

describe('sqlite TraceStore (ADR-081)', () => {
  it('opens, migrates in-process, and applies WAL', () => {
    const db = openDb(tmpDb())
    const mode = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }
    expect(mode.journal_mode.toLowerCase()).toBe('wal')
    // migrations are recorded so a second launch is a no-op
    expect((db.prepare('SELECT COUNT(*) c FROM _migrations').get() as { c: number }).c).toBeGreaterThan(0)
  })

  it('migrating twice is idempotent (every launch re-runs openDb)', () => {
    const f = tmpDb()
    const first = openDb(f)
    const applied = (first.prepare('SELECT COUNT(*) c FROM _migrations').get() as { c: number }).c
    first.close()
    const db = openDb(f)
    // Asserts the PROPERTY (a second launch applies nothing new), not a fixed count — pinning the count
    // would make every future migration a test failure, which teaches people to edit the assertion.
    expect((db.prepare('SELECT COUNT(*) c FROM _migrations').get() as { c: number }).c).toBe(applied)
    expect(applied).toBeGreaterThan(0)
  })

  it('record() is fire-and-forget yet readable immediately (reads flush the buffer)', async () => {
    const store = createTraceStore(openDb(tmpDb()))
    store.record(span({ spanId: 'a', parentSpanId: undefined, name: 'agent', kind: 'AGENT' }))
    store.record(span({ spanId: 'b', parentSpanId: 'a' }))
    // No await on record — the agent loop must never wait on telemetry.
    const spans = await store.spans('t1')
    expect(spans).toHaveLength(2)
    expect(spans.find((s) => s.spanId === 'b')?.parentSpanId).toBe('a')
  })

  it('summarises a trace from its ROOT span and counts children', async () => {
    const store = createTraceStore(openDb(tmpDb()))
    store.record(span({ spanId: 'root', name: 'agent (builder)', kind: 'AGENT', startedAt: 500, endedAt: 3000, attributes: { 'cascade.project_id': 'p1', 'llm.model_name': 'qwen' } }))
    store.record(span({ spanId: 'c1', parentSpanId: 'root' }))
    const [t] = await store.listTraces()
    expect(t.name).toBe('agent (builder)')
    expect(t.spanCount).toBe(2)
    expect(t.durationMs).toBe(2500) // MIN(start)→MAX(end), not just the root's own span
    expect(t.projectId).toBe('p1')
    expect(t.model).toBe('qwen')
  })

  it('reports a trace as RUNNING while any span is still open, with no duration', async () => {
    // Without this a live build is indistinguishable from a finished one in the list, and its duration —
    // computed from only the spans that already closed — reads as a suspiciously fast turn.
    const store = createTraceStore(openDb(tmpDb()))
    store.record(span({ spanId: 'root', kind: 'AGENT', startedAt: 500, endedAt: undefined }))
    store.record(span({ spanId: 'c1', parentSpanId: 'root', startedAt: 600, endedAt: 700 }))
    const [t] = await store.listTraces()
    expect(t.running).toBe(true)
    expect(t.durationMs).toBeUndefined()
  })

  it('a finished trace is not running and keeps its duration', async () => {
    const store = createTraceStore(openDb(tmpDb()))
    store.record(span({ spanId: 'root', kind: 'AGENT', startedAt: 500, endedAt: 3000 }))
    const [t] = await store.listTraces()
    expect(t.running).toBe(false)
    expect(t.durationMs).toBe(2500)
  })

  it('a running trace can ALSO be errored — the two facts are independent', async () => {
    // A tool failed and the turn is still going. Collapsing status and running would hide one of them.
    const store = createTraceStore(openDb(tmpDb()))
    store.record(span({ spanId: 'root', kind: 'AGENT', startedAt: 1, endedAt: undefined }))
    store.record(span({ spanId: 'bad', parentSpanId: 'root', status: 'error' }))
    const [t] = await store.listTraces()
    expect(t.running).toBe(true)
    expect(t.status).toBe('error')
  })

  it('marks a trace errored if ANY span failed', async () => {
    const store = createTraceStore(openDb(tmpDb()))
    store.record(span({ spanId: 'r', status: 'ok' }))
    store.record(span({ spanId: 'x', parentSpanId: 'r', status: 'error' }))
    expect((await store.listTraces())[0].status).toBe('error')
  })

  it('re-recording the same span id upserts rather than duplicating', async () => {
    const store = createTraceStore(openDb(tmpDb()))
    store.record(span({ spanId: 'dup', endedAt: undefined, status: undefined }))
    await store.flush()
    store.record(span({ spanId: 'dup', endedAt: 9999, status: 'error' }))
    const spans = await store.spans('t1')
    expect(spans).toHaveLength(1)
    expect(spans[0].endedAt).toBe(9999)
    expect(spans[0].status).toBe('error')
  })

  it('prune() drops old spans so a long-lived desktop install cannot grow forever', async () => {
    const store = createTraceStore(openDb(tmpDb()))
    store.record(span({ spanId: 'old', startedAt: 1 }))
    store.record(span({ spanId: 'new', startedAt: Date.now() }))
    const removed = await store.prune(60_000)
    expect(removed).toBe(1)
    expect((await store.spans('t1')).map((s) => s.spanId)).toEqual(['new'])
  })

  it('filters by project', async () => {
    const store = createTraceStore(openDb(tmpDb()))
    store.record(span({ traceId: 'tA', spanId: 'a', attributes: { 'cascade.project_id': 'p1' } }))
    store.record(span({ traceId: 'tB', spanId: 'b', attributes: { 'cascade.project_id': 'p2' } }))
    const only = await store.listTraces({ projectId: 'p2' })
    expect(only.map((t) => t.traceId)).toEqual(['tB'])
  })

  // ── Filtering, paging, cross-trace search (ADR-081: what makes it more than a viewer) ────────────────

  /** Two traces: one clean, one with a failed tool. Enough to exercise every filter. */
  const seeded = () => {
    const store = createTraceStore(openDb(tmpDb()))
    store.record(span({ traceId: 'ok1', spanId: 'r1', parentSpanId: undefined, name: 'agent (builder)', kind: 'AGENT', startedAt: 2000, endedAt: 2500, status: 'ok', attributes: { 'cascade.project_id': 'p1', 'cascade.model': 'qwen', 'cascade.chat_id': 'chat-a', input: 'add a favourites filter' } }))
    store.record(span({ traceId: 'ok1', spanId: 'r1c', parentSpanId: 'r1', name: 'tool Read', kind: 'TOOL', startedAt: 2100, endedAt: 2200, status: 'ok', attributes: { 'cascade.project_id': 'p1', input: '{"file_path":"src/App.tsx"}' } }))
    store.record(span({ traceId: 'bad1', spanId: 'r2', parentSpanId: undefined, name: 'agent (builder)', kind: 'AGENT', startedAt: 1000, endedAt: 1500, status: 'ok', attributes: { 'cascade.project_id': 'p2', 'cascade.model': 'gpt-oss', input: 'build a shop' } }))
    store.record(span({ traceId: 'bad1', spanId: 'r2c', parentSpanId: 'r2', name: 'tool Bash', kind: 'TOOL', startedAt: 1100, endedAt: 1200, status: 'error', attributes: { 'cascade.project_id': 'p2', output: 'sh: tsc: not found' } }))
    return store
  }

  it('filters the list to ERRORED turns — the first question anyone asks', async () => {
    const t = await seeded().listTraces({ status: 'error' })
    expect(t.map((x) => x.traceId)).toEqual(['bad1'])
  })

  it('filters by model and by project', async () => {
    const store = seeded()
    expect((await store.listTraces({ model: 'qwen' })).map((t) => t.traceId)).toEqual(['ok1'])
    expect((await store.listTraces({ projectId: 'p2' })).map((t) => t.traceId)).toEqual(['bad1'])
  })

  it('searches the USER PROMPT, not just the span name', async () => {
    // Every root is called "agent (builder)", so a name-only search would match all of them or none. What
    // distinguishes turns is what was asked.
    const t = await seeded().listTraces({ q: 'favourites' })
    expect(t.map((x) => x.traceId)).toEqual(['ok1'])
  })

  it('pages with the `before` cursor WITHOUT corrupting the aggregate', async () => {
    // The bug this pins: with `started_at < before` in WHERE, a trace's late spans are excluded from its
    // own GROUP BY, so span_count and duration come back wrong on every page but the first.
    const store = seeded()
    const [first] = await store.listTraces({ limit: 1 })
    expect(first.traceId).toBe('ok1')
    expect(first.spanCount).toBe(2)
    const next = await store.listTraces({ before: first.startedAt })
    expect(next.map((t) => t.traceId)).toEqual(['bad1'])
    expect(next[0].spanCount).toBe(2) // NOT 1 — the child at 1100 is still counted
    expect(next[0].durationMs).toBe(500)
  })

  it('pages past traces that TIE on the cursor millisecond', async () => {
    // Measured in the running app: 150 traces paged out as 136. `MIN(started_at) < cursor` silently drops
    // every trace sharing the boundary millisecond, and fast successive turns (or a backfill replaying
    // recorded timestamps) tie constantly. The tie-break makes the comparison agree with the ORDER BY.
    const store = createTraceStore(openDb(tmpDb()))
    for (let i = 0; i < 6; i++) store.record(span({ traceId: `t${i}`, spanId: `s${i}`, parentSpanId: undefined, kind: 'AGENT', startedAt: 5000, endedAt: 5001 }))
    const seen = new Set<string>()
    let cursor: { before: number; beforeId: string } | undefined
    for (let page = 0; page < 4; page++) {
      const rows = await store.listTraces({ limit: 2, ...cursor })
      if (!rows.length) break
      for (const r of rows) seen.add(r.traceId)
      cursor = { before: rows[rows.length - 1].startedAt, beforeId: rows[rows.length - 1].traceId }
    }
    expect([...seen].sort()).toEqual(['t0', 't1', 't2', 't3', 't4', 't5']) // all six, none skipped or repeated
  })

  it('carries the chat id so a trace can be opened back in its conversation', async () => {
    expect((await seeded().listTraces({ q: 'favourites' }))[0].chatId).toBe('chat-a')
  })

  it('searchSpans answers ACROSS traces — the question a per-trace view cannot', async () => {
    const store = seeded()
    // "every failed tool call, anywhere"
    const failed = await store.searchSpans({ status: 'error' })
    expect(failed.map((s) => s.spanId)).toEqual(['r2c'])
    // …by kind
    expect((await store.searchSpans({ kind: 'TOOL' })).map((s) => s.spanId).sort()).toEqual(['r1c', 'r2c'])
    // …and by free text over BOTH name and attributes, because a user hunting a failure does not know
    // which of those their memory of it lives in.
    expect((await store.searchSpans({ q: 'Bash' })).map((s) => s.spanId)).toEqual(['r2c'])
    expect((await store.searchSpans({ q: 'tsc: not found' })).map((s) => s.spanId)).toEqual(['r2c'])
    expect((await store.searchSpans({ q: 'src/App.tsx' })).map((s) => s.spanId)).toEqual(['r1c'])
  })

  it('lists the models actually present, most recently used first', async () => {
    expect(await seeded().models()).toEqual(['qwen', 'gpt-oss'])
  })

  it('migrating an EXISTING db forward adds the chat column without losing rows', async () => {
    // The real upgrade path: someone already ran the app before chat linkage existed.
    const f = tmpDb()
    const before = createTraceStore(openDb(f))
    before.record(span({ spanId: 'old', attributes: { 'cascade.project_id': 'p1' } }))
    await before.flush()
    const after = createTraceStore(openDb(f)) // reopen ⇒ migration 002 runs on populated data
    const spans = await after.spans('t1')
    expect(spans.map((s) => s.spanId)).toEqual(['old'])
    expect((await after.listTraces())[0].chatId).toBeUndefined()
  })

  it('batches: 5000 spans land in one flush without blocking', async () => {
    const store = createTraceStore(openDb(tmpDb()))
    const t0 = Date.now()
    for (let i = 0; i < 5000; i++) store.record(span({ spanId: `s${i}`, startedAt: 1000 + i }))
    await store.flush()
    // The ADR's premise: our load is orders of magnitude below what stresses SQLite.
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(await store.spans('t1')).toHaveLength(5000)
  })
})
