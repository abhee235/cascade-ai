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
    openDb(f).close()
    const db = openDb(f)
    expect((db.prepare('SELECT COUNT(*) c FROM _migrations').get() as { c: number }).c).toBe(1)
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
