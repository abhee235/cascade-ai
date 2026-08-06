// The Observatory's READ path over the socket (ADR-081).
//
// The store itself is tested in storage-sqlite; what is tested here is what the SERVER does on top of it —
// which is where the two rules that matter live: never serve a trace whose project is gone, and never
// require a store to exist at all.
import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SpanRecord, TraceStore, TraceSummary } from '@cascade/storage'
import { handleConnection } from '../src/wsServer'
import { ProjectManager } from '../src/projectManager'
import { createSession, type ModelProvider } from '@cascade/core'

const fakeProvider: ModelProvider = {
  id: 'fake',
  async complete() {
    return { text: '' }
  },
  async *stream() {
    yield { type: 'done', stopReason: 'end_turn' }
  },
}

const manager = () =>
  new ProjectManager({
    root: mkdtempSync(join(tmpdir(), 'cascade-obs-')),
    model: 'fake',
    createSessionFor: (dir) => createSession({ cwd: dir, provider: fakeProvider, model: 'fake' }),
  })

class MockWs extends EventEmitter {
  readonly OPEN = 1
  readyState = 1
  sent: Array<Record<string, unknown>> = []
  send(data: string) {
    this.sent.push(JSON.parse(data))
  }
}

/** An in-memory TraceStore — the port, not the SQLite adapter. The server must not care which it got. */
function memoryStore(traces: TraceSummary[], spans: SpanRecord[] = []): TraceStore {
  return {
    record() {},
    async listTraces(opts) {
      return traces.filter((t) => !opts?.projectId || t.projectId === opts.projectId)
    },
    async spans(traceId) {
      return spans.filter((s) => s.traceId === traceId)
    },
    async prune() {
      return 0
    },
    async flush() {},
  }
}

const send = (ws: MockWs, msg: unknown) => ws.emit('message', JSON.stringify(msg))
const last = (ws: MockWs, type: string) => [...ws.sent].reverse().find((e) => e.type === type) as Record<string, unknown> | undefined
const waitFor = async (fn: () => boolean, timeout = 2000) => {
  const t0 = Date.now()
  while (!fn()) {
    if (Date.now() - t0 > timeout) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 5))
  }
}

const summary = (o: Partial<TraceSummary> & { traceId: string }): TraceSummary => ({ name: 'agent (builder)', startedAt: 1000, spanCount: 3, ...o })

describe('Observatory protocol (ADR-081)', () => {
  it('serves the trace list', async () => {
    const ws = new MockWs()
    const mgr = manager()
    const p = mgr.create('Shop')
    handleConnection(ws as never, mgr, undefined, undefined, undefined, undefined, undefined, undefined, memoryStore([summary({ traceId: 'T1', projectId: p.id, model: 'qwen' })]))
    send(ws, { type: 'traces', action: 'list' })
    await waitFor(() => !!last(ws, 'traces'))
    expect(last(ws, 'traces')?.traces).toMatchObject([{ traceId: 'T1', model: 'qwen' }])
  })

  it('hides traces whose project was DELETED — a row you cannot open is worse than no row', async () => {
    // Spans outlive their project: retention prunes on a 14-day clock, deletion is immediate. Without this
    // filter the list fills with turns belonging to nothing, each opening onto an unnamed waterfall.
    const ws = new MockWs()
    const mgr = manager()
    const alive = mgr.create('Alive')
    handleConnection(
      ws as never,
      mgr,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      memoryStore([summary({ traceId: 'T1', projectId: alive.id }), summary({ traceId: 'T2', projectId: 'deleted-project-id' })]),
    )
    send(ws, { type: 'traces', action: 'list' })
    await waitFor(() => !!last(ws, 'traces'))
    expect((last(ws, 'traces')?.traces as { traceId: string }[]).map((t) => t.traceId)).toEqual(['T1'])
  })

  it('keeps a trace with NO project — an eval/bench run is still worth reading', async () => {
    const ws = new MockWs()
    handleConnection(ws as never, manager(), undefined, undefined, undefined, undefined, undefined, undefined, memoryStore([summary({ traceId: 'T1' })]))
    send(ws, { type: 'traces', action: 'list' })
    await waitFor(() => !!last(ws, 'traces'))
    expect((last(ws, 'traces')?.traces as unknown[]).length).toBe(1)
  })

  it('serves one trace\'s spans', async () => {
    const ws = new MockWs()
    const spans: SpanRecord[] = [
      { traceId: 'T1', spanId: 's1', name: 'agent', kind: 'AGENT', startedAt: 1000, endedAt: 2000, status: 'ok' },
      { traceId: 'T1', spanId: 's2', parentSpanId: 's1', name: 'llm turn 0', kind: 'LLM', startedAt: 1100, endedAt: 1500 },
      { traceId: 'T2', spanId: 'other', name: 'agent', kind: 'AGENT', startedAt: 1 },
    ]
    handleConnection(ws as never, manager(), undefined, undefined, undefined, undefined, undefined, undefined, memoryStore([summary({ traceId: 'T1' })], spans))
    send(ws, { type: 'trace', action: 'spans', traceId: 'T1' })
    await waitFor(() => !!last(ws, 'traceSpans'))
    const got = last(ws, 'traceSpans')!
    expect(got.traceId).toBe('T1')
    expect((got.spans as { spanId: string }[]).map((s) => s.spanId)).toEqual(['s1', 's2']) // T2's span stayed out
  })

  it('with NO store the page gets an empty list, not a broken socket', async () => {
    // A deployment that stores no traces is a valid deployment (headless, tests, a future hosted tier with
    // telemetry off). It must answer the question, not fail to answer it.
    const ws = new MockWs()
    handleConnection(ws as never, manager())
    send(ws, { type: 'traces', action: 'list' })
    await waitFor(() => !!last(ws, 'traces'))
    expect(last(ws, 'traces')?.traces).toEqual([])
  })
})
