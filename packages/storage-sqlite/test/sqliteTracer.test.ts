// Folding core's FLAT event stream into a span tree is the whole job of this tracer, so the tests
// replay realistic event sequences and assert on the tree the Observatory will render.
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/db.js'
import { createTraceStore } from '../src/traceStore.js'
import { createSqliteTracer } from '../src/sqliteTracer.js'

const setup = (rootName?: string) => {
  const store = createTraceStore(openDb(join(mkdtempSync(join(tmpdir(), 'cascade-tr-')), 'x.db')))
  const tracer = createSqliteTracer(store, { traceId: 'T', projectId: 'p1', model: 'qwen', rootName })
  // biome-ignore lint/suspicious/noExplicitAny: the tracer takes core's TraceEvent; tests feed literals
  const emit = (e: Record<string, unknown>) => tracer.event(e as any)
  return { store, emit }
}

describe('SqliteTracer — event stream → span tree', () => {
  it('builds root → LLM → TOOL with the right parents and kinds', async () => {
    const { store, emit } = setup('agent (builder)')
    emit({ t: 'submit', text: 'build me a shop' })
    emit({ t: 'model_request', turn: 0, provider: 'ollama', model: 'qwen' })
    emit({ t: 'model_response', turn: 0, text: 'ok', usage: { inputTokens: 10, outputTokens: 3 } })
    emit({ t: 'tool_call', id: 'c1', name: 'Write', input: { file_path: 'a.ts' } })
    emit({ t: 'tool_result', id: 'c1', name: 'Write', ok: true, ms: 12, content: 'wrote' })
    emit({ t: 'turn_done', turns: 1 })

    const spans = await store.spans('T')
    const root = spans.find((s) => s.kind === 'AGENT')!
    expect(root.name).toBe('agent (builder)')
    expect(root.parentSpanId).toBeUndefined()
    expect(root.endedAt).toBeDefined() // turn_done closed it
    for (const kind of ['LLM', 'TOOL']) {
      const s = spans.find((x) => x.kind === kind)!
      expect(s.parentSpanId).toBe(root.spanId) // children hang off the root, not each other
      expect(s.endedAt).toBeDefined()
    }
  })

  it('carries the token/timing observables that diagnosis depends on', async () => {
    const { store, emit } = setup()
    emit({ t: 'submit', text: 'x' })
    emit({ t: 'model_request', turn: 0, provider: 'ollama', model: 'qwen', contextWindow: 65536 })
    emit({ t: 'model_response', turn: 0, text: 'y', usage: { inputTokens: 4200, outputTokens: 55, promptEvalMs: 900, decodeMs: 300 } })
    const llm = (await store.spans('T')).find((s) => s.kind === 'LLM')!
    expect(llm.attributes?.contextWindow).toBe(65536)
    expect(llm.attributes?.inputTokens).toBe(4200)
    expect(llm.attributes?.promptEvalMs).toBe(900)
  })

  it('uses the tool result ms as the span duration, not wall-clock bookkeeping', async () => {
    const { store, emit } = setup()
    emit({ t: 'submit', text: 'x' })
    emit({ t: 'tool_call', id: 'c1', name: 'Bash' })
    emit({ t: 'tool_result', id: 'c1', name: 'Bash', ok: true, ms: 4321, content: '' })
    const tool = (await store.spans('T')).find((s) => s.kind === 'TOOL')!
    expect((tool.endedAt ?? 0) - tool.startedAt).toBe(4321)
  })

  it('marks a failed tool as error so the trace rolls up red', async () => {
    const { store, emit } = setup()
    emit({ t: 'submit', text: 'x' })
    emit({ t: 'tool_call', id: 'c1', name: 'Read' })
    emit({ t: 'tool_result', id: 'c1', name: 'Read', ok: false, ms: 2, content: 'ENOENT' })
    expect((await store.spans('T')).find((s) => s.kind === 'TOOL')?.status).toBe('error')
    expect((await store.listTraces())[0].status).toBe('error')
  })

  it('records loop breakers as marks — a firing gate must be visible on the waterfall', async () => {
    const { store, emit } = setup()
    emit({ t: 'submit', text: 'x' })
    emit({ t: 'narration_loop', turn: 101 })
    emit({ t: 'repeat_call', turn: 102, tool: 'Read' })
    emit({ t: 'tool_cap', turn: 103, calls: 100 })
    const marks = (await store.spans('T')).filter((s) => s.kind === 'CHAIN')
    expect(marks.map((m) => m.name).sort()).toEqual(['narration_loop', 'repeat_call', 'tool_cap'])
    expect(marks.every((m) => m.endedAt === m.startedAt)).toBe(true) // zero-duration
    expect(marks.find((m) => m.name === 'repeat_call')?.attributes?.tool).toBe('Read')
  })

  it('ignores unremarkable events rather than flooding the trace', async () => {
    const { store, emit } = setup()
    emit({ t: 'submit', text: 'x' })
    emit({ t: 'permission', id: 'p' })
    emit({ t: 'hook', name: 'x' })
    expect((await store.spans('T')).filter((s) => s.kind === 'CHAIN')).toHaveLength(0)
  })

  it('interleaved tool calls close against their OWN id', async () => {
    const { store, emit } = setup()
    emit({ t: 'submit', text: 'x' })
    emit({ t: 'tool_call', id: 'a', name: 'Read' })
    emit({ t: 'tool_call', id: 'b', name: 'Glob' })
    emit({ t: 'tool_result', id: 'b', name: 'Glob', ok: true, ms: 5, content: '' })
    emit({ t: 'tool_result', id: 'a', name: 'Read', ok: true, ms: 50, content: '' })
    const tools = (await store.spans('T')).filter((s) => s.kind === 'TOOL')
    const byName = Object.fromEntries(tools.map((t) => [t.name, (t.endedAt ?? 0) - t.startedAt]))
    expect(byName['tool Glob']).toBe(5)
    expect(byName['tool Read']).toBe(50)
  })

  it('gives every submit its OWN trace — a trace is a turn, not a session', async () => {
    // The tracer lives as long as the session (days). Without this, turn 40 appends to the same trace as
    // turn 1 and the Observatory shows one unreadable row with 40 roots instead of 40 waterfalls.
    const store = createTraceStore(openDb(join(mkdtempSync(join(tmpdir(), 'cascade-tr-')), 'x.db')))
    const tracer = createSqliteTracer(store, { projectId: 'p1' }) // no pinned traceId — the product path
    // biome-ignore lint/suspicious/noExplicitAny: the tracer takes core's TraceEvent; tests feed literals
    const emit = (e: Record<string, unknown>) => tracer.event(e as any)
    for (const text of ['first turn', 'second turn']) {
      emit({ t: 'submit', text })
      emit({ t: 'tool_call', id: 'c1', name: 'Write' })
      emit({ t: 'tool_result', id: 'c1', name: 'Write', ok: true, ms: 1, content: '' })
      emit({ t: 'turn_done', turns: 1 })
    }
    const traces = await store.listTraces()
    expect(traces).toHaveLength(2)
    expect(traces.every((t) => t.spanCount === 2)).toBe(true) // each turn kept its own root + tool
  })

  it('stamps project and model on every span so the Observatory can filter without a join', async () => {
    const { store, emit } = setup()
    emit({ t: 'submit', text: 'x' })
    emit({ t: 'model_request', turn: 0, provider: 'ollama', model: 'qwen' })
    const [t] = await store.listTraces({ projectId: 'p1' })
    expect(t.traceId).toBe('T')
    expect(t.model).toBe('qwen')
  })
})
