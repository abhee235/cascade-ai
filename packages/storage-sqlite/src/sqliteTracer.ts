// sqliteTracer.ts — the third Tracer implementation (ADR-081 §5), beside JsonlTracer and OtelTracer.
//
// Core emits a FLAT event stream (`{t:'model_request'…}`), not spans, so — exactly as OtelTracer does
// — this folds that stream into a span tree the Observatory can render:
//
//   submit ─────────────► one AGENT root span for the whole turn
//     model_request ────► an LLM span, closed by the matching model_response (carries tokens/timings)
//     tool_call ────────► a TOOL span, closed by tool_result with the same id (carries ok/duration)
//     <nudges/gates> ───► zero-duration CHAIN marks, so a breaker firing is visible on the waterfall
//   turn_done ──────────► closes the root
//
// It writes through TraceStore, so it inherits the buffered writer: `event()` stays fire-and-forget
// and the agent loop never waits on storage. Compose it with the others via core's `fanout`.

import type { SpanRecord, TraceStore } from '@cascade/storage'

/** Structural copy of core's Tracer/TraceEvent — importing @cascade/core here would make the storage
 *  adapter depend on the agent, and the dependency only ever needs to point the other way. */
interface TraceEventLike {
  t: string
  [k: string]: unknown
}
export interface TracerLike {
  event(e: never): void
}

/** Marks worth seeing on a waterfall: a loop breaker or gate firing explains a turn's shape. */
const MARK_EVENTS = new Set([
  'compaction',
  'verify_gate',
  'todo_gate',
  'read_loop',
  're_edit',
  'narration_loop',
  'repeat_call',
  'tool_cap',
  'stalled_verify',
  'post_edit_check',
  'max_tokens_cut',
  'degraded_retry',
  'slow_prefill',
  'recall',
  'error',
])

let counter = 0
const id = (p: string) => `${p}${(++counter).toString(36)}${Date.now().toString(36).slice(-4)}`

export interface SqliteTracerOptions {
  /** PIN the trace id (tests, replay/backfill). Omit in the product: every submit mints its own, because
   *  a TRACE is one turn — a session lives for days, and lumping its turns into one trace gives the
   *  Observatory a single ever-growing row with N roots instead of the per-turn waterfall you read. */
  traceId?: string
  /** Stamped on every span so the Observatory can filter by project without joining. */
  projectId?: string
  model?: string
  /** Names the root span, e.g. 'agent (builder)' / 'agent (planner)'. */
  rootName?: string
  now?: () => number
}

/**
 * One instance per SESSION (same lifetime rule as JsonlTracer): it holds the open spans for that
 * session's turn. Safe to construct per session — spans are keyed by a generated id, never shared.
 */
export function createSqliteTracer(store: TraceStore, opts: SqliteTracerOptions = {}): TracerLike {
  const now = opts.now ?? (() => Date.now())
  // Mutable: reassigned per submit unless pinned (see SqliteTracerOptions.traceId). Seeded so a mark
  // arriving before the first submit still lands somewhere rather than being dropped.
  let traceId = opts.traceId ?? id('t')
  const attributes = { 'cascade.project_id': opts.projectId, 'cascade.model': opts.model } as Record<string, unknown>

  let rootId: string | undefined
  let rootStart = 0
  // `attrs` is carried so CLOSING the span can re-send them: the store upserts by span_id and
  // REPLACES the attribute blob, so request-time fields (provider/contextWindow) would otherwise be
  // erased by the response write — losing exactly the observables diagnosis depends on.
  let llm: { spanId: string; start: number; attrs: Record<string, unknown> } | undefined
  const tools = new Map<string, { spanId: string; start: number }>()

  // traceId is read at CALL time, not captured — a new submit must redirect subsequent spans.
  const write = (s: Omit<SpanRecord, 'traceId'>) => store.record({ traceId, ...s, attributes: { ...attributes, ...s.attributes } })

  return {
    event(raw: never): void {
      const e = raw as unknown as TraceEventLike
      const at = now()
      switch (e.t) {
        case 'submit': {
          if (!opts.traceId) traceId = id('t') // one trace per TURN — a session spans days
          rootId = id('s')
          rootStart = at
          // Left OPEN until turn_done; the store upserts by span_id, so closing later just updates it.
          write({ spanId: rootId, name: opts.rootName ?? 'agent', kind: 'AGENT', startedAt: at, attributes: { input: String(e.text ?? '').slice(0, 2000) } })
          break
        }
        case 'model_request': {
          const attrs = { provider: e.provider, model: e.model, contextWindow: e.contextWindow }
          llm = { spanId: id('l'), start: at, attrs }
          write({ spanId: llm.spanId, parentSpanId: rootId, name: `llm turn ${e.turn ?? 0}`, kind: 'LLM', startedAt: at, attributes: attrs })
          break
        }
        case 'model_response': {
          if (!llm) break
          const u = (e.usage ?? {}) as Record<string, number>
          write({
            spanId: llm.spanId,
            parentSpanId: rootId,
            name: `llm turn ${e.turn ?? 0}`,
            kind: 'LLM',
            startedAt: llm.start,
            endedAt: at,
            status: 'ok',
            // The observables that made every diagnosis this cycle possible.
            attributes: { ...llm.attrs, output: String(e.text ?? '').slice(0, 2000), inputTokens: u.inputTokens, outputTokens: u.outputTokens, promptEvalMs: u.promptEvalMs, decodeMs: u.decodeMs },
          })
          llm = undefined
          break
        }
        case 'tool_call': {
          const sid = id('x')
          tools.set(String(e.id), { spanId: sid, start: at })
          write({ spanId: sid, parentSpanId: rootId, name: `tool ${e.name}`, kind: 'TOOL', startedAt: at, attributes: { input: JSON.stringify(e.input ?? {}).slice(0, 2000) } })
          break
        }
        case 'tool_result': {
          const open = tools.get(String(e.id))
          if (!open) break
          tools.delete(String(e.id))
          write({
            spanId: open.spanId,
            parentSpanId: rootId,
            name: `tool ${e.name}`,
            kind: 'TOOL',
            startedAt: open.start,
            // ms from the event is authoritative: it measures the tool, not our bookkeeping.
            endedAt: open.start + (typeof e.ms === 'number' ? e.ms : at - open.start),
            status: e.ok === false ? 'error' : 'ok',
            attributes: { output: String(e.content ?? '').slice(0, 2000) },
          })
          break
        }
        case 'turn_done': {
          if (rootId) write({ spanId: rootId, name: opts.rootName ?? 'agent', kind: 'AGENT', startedAt: rootStart, endedAt: at, status: 'ok', attributes: { turns: e.turns } })
          rootId = undefined
          break
        }
        default: {
          // Zero-duration mark so a gate/breaker firing is visible in the waterfall at the right moment.
          if (MARK_EVENTS.has(e.t)) {
            const { t, ...rest } = e
            write({ spanId: id('m'), parentSpanId: rootId, name: t, kind: 'CHAIN', startedAt: at, endedAt: at, status: t === 'error' ? 'error' : 'ok', attributes: rest })
          }
        }
      }
    },
  }
}
