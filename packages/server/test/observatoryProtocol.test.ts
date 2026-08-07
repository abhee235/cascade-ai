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

/** An in-memory TraceStore — the port, not the SQLite adapter. The server must not care which it got.
 *  `seen` records the options it was called with, so the tests can assert the SERVER forwards filters
 *  rather than re-implementing filtering here (which would test the fake, not the server). */
function memoryStore(traces: TraceSummary[], spans: SpanRecord[] = [], seen: Record<string, unknown> = {}): TraceStore {
  return {
    record() {},
    async listTraces(opts) {
      seen.list = opts
      return traces.filter((t) => !opts?.projectId || t.projectId === opts.projectId)
    },
    async spans(traceId) {
      return spans.filter((s) => s.traceId === traceId)
    },
    async span(spanId) {
      return spans.find((s) => s.spanId === spanId)
    },
    async listSessions(opts) {
      seen.sessions = opts
      return [{ chatId: 'c1', projectId: traces[0]?.projectId, turnCount: 3, startedAt: 1, endedAt: 2, errorTurns: 1, outputTokens: 40, models: ['qwen'] }]
    },
    async searchSpans(opts) {
      seen.search = opts
      return spans
    },
    async models() {
      return ['qwen', 'gpt-oss']
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

  it('forwards every filter to the store, and sends the model list only on the FIRST page', async () => {
    // The filters are the store's job; the server's job is not to swallow them. And the model list is the
    // filter's option set — re-sending it on every 3s poll is noise on a socket that is also carrying a build.
    const ws = new MockWs()
    const seen: Record<string, unknown> = {}
    handleConnection(ws as never, manager(), undefined, undefined, undefined, undefined, undefined, undefined, memoryStore([summary({ traceId: 'T1' })], [], seen))

    send(ws, { type: 'traces', action: 'list', model: 'qwen', status: 'error', q: 'favourites', limit: 25 })
    await waitFor(() => !!last(ws, 'traces'))
    expect(seen.list).toMatchObject({ model: 'qwen', status: 'error', q: 'favourites', limit: 25 })
    expect(last(ws, 'traces')?.models).toEqual(['qwen', 'gpt-oss'])
    expect(last(ws, 'traces')?.append).toBe(false)

    ws.sent.length = 0
    send(ws, { type: 'traces', action: 'list', before: 1000 })
    await waitFor(() => !!last(ws, 'traces'))
    expect(last(ws, 'traces')?.append).toBe(true) // a PAGE: the client concatenates
    expect(last(ws, 'traces')?.models).toBeUndefined()
  })

  it('searches spans ACROSS traces, and still hides deleted projects', async () => {
    const ws = new MockWs()
    const mgr = manager()
    const alive = mgr.create('Alive')
    const spans: SpanRecord[] = [
      { traceId: 'T1', spanId: 'live', name: 'tool Bash', kind: 'TOOL', startedAt: 1, status: 'error', attributes: { 'cascade.project_id': alive.id } },
      { traceId: 'T2', spanId: 'ghost', name: 'tool Bash', kind: 'TOOL', startedAt: 2, status: 'error', attributes: { 'cascade.project_id': 'deleted' } },
      { traceId: 'T3', spanId: 'orphan', name: 'tool Bash', kind: 'TOOL', startedAt: 3, status: 'error' },
    ]
    const seen: Record<string, unknown> = {}
    handleConnection(ws as never, mgr, undefined, undefined, undefined, undefined, undefined, undefined, memoryStore([], spans, seen))

    send(ws, { type: 'spans', action: 'search', q: 'Bash', kind: 'TOOL', status: 'error' })
    await waitFor(() => !!last(ws, 'spanResults'))
    expect(seen.search).toMatchObject({ q: 'Bash', kind: 'TOOL', status: 'error' })
    // The ghost's project is gone; the orphan has none (an eval run) and is still worth reading.
    expect((last(ws, 'spanResults')?.spans as { spanId: string }[]).map((s) => s.spanId)).toEqual(['live', 'orphan'])
  })

  it('TRIMS payloads for the tree but serves ONE span whole', async () => {
    // Prompts are stored uncapped now — they are the forensic record. The tree fetch repeats every 3s
    // while a trace is open, so shipping them there would push megabytes per tick down a socket that is
    // also carrying a live build. The detail pane asks for the one span it is showing.
    const ws = new MockWs()
    const big = 'x'.repeat(5_000)
    const spans: SpanRecord[] = [{ traceId: 'T1', spanId: 's1', name: 'tool Write', kind: 'TOOL', startedAt: 1, endedAt: 2, attributes: { input: big, toolName: 'Write' } }]
    handleConnection(ws as never, manager(), undefined, undefined, undefined, undefined, undefined, undefined, memoryStore([summary({ traceId: 'T1' })], spans))

    send(ws, { type: 'trace', action: 'spans', traceId: 'T1' })
    await waitFor(() => !!last(ws, 'traceSpans'))
    const fromTree = (last(ws, 'traceSpans')?.spans as { attributes: Record<string, string>; trimmed?: boolean }[])[0]
    expect(fromTree.attributes.input.length).toBeLessThan(1_000)
    expect(fromTree.trimmed).toBe(true) // flagged, so the client knows to ask rather than show a cut prompt
    expect(fromTree.attributes.toolName).toBe('Write') // short values pass through untouched

    send(ws, { type: 'span', action: 'detail', spanId: 's1' })
    await waitFor(() => !!last(ws, 'spanDetail'))
    expect(((last(ws, 'spanDetail')?.span as { attributes: Record<string, string> }).attributes.input)).toHaveLength(5_000)
  })

  it('with NO store a span search answers empty rather than failing', async () => {
    const ws = new MockWs()
    handleConnection(ws as never, manager())
    send(ws, { type: 'spans', action: 'search', q: 'x' })
    await waitFor(() => !!last(ws, 'spanResults'))
    expect(last(ws, 'spanResults')?.spans).toEqual([])
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
