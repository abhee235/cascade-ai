// spanFold.ts — the ONE place Cascade's flat event stream becomes spans (ADR-081, amended 2026-08-07).
//
// WHY THIS EXISTS. There were two hand-written folds: OtelTracer (→ OTLP/Phoenix) and SqliteTracer
// (→ the in-app Observatory). Feeding both from a single replay and diffing the result measured the
// cost: SIX event types reached Phoenix and were silently dropped by the Observatory
// (delegate_nudge, plan_nudge, degenerate_cut, planning_stall, hook, permission), THREE reached the
// Observatory and were dropped by Phoenix (narration_loop, repeat_call, tool_cap — the newest loop
// breakers, which otelTracer had no `case` for), and the Observatory was missing the LLM prompt, the
// model's reasoning, prefill throughput, arg-repair and model-load timings entirely.
//
// None of that was a bug anyone wrote. It is what two parallel implementations of the same mapping do.
// So the mapping lives here once, and a "tracer" is now just a SINK: OtelTracer turns these spans into
// OTLP, the desktop writes them to SQLite. Adding an event type or an attribute updates both viewers.
//
// WHY SPANS ARE EMITTED TWICE. `emit` fires on OPEN (no `endedAt`) and again on CLOSE (same `spanId`,
// `endedAt` set). Sinks choose:
//   - a store that upserts by span id takes BOTH, so a turn IN FLIGHT is visible while it runs;
//   - OTLP can only export an ended span, so its sink ignores the open record and acts on the close.
// That difference is a property of the transport, not of the mapping — which is exactly why it belongs
// in the sink and not here.
//
// Span tree per submit:  AGENT (submit … turn_done)
//                          ├─ LLM  turn N   (model_request … model_response)
//                          ├─ TOOL <name>   (tool_call … tool_result)
//                          └─ CHAIN marks   (a gate fired, a compaction ran, a prefill stalled)

import type { TraceEvent, Tracer } from './tracer'

/** One span, flattened. Structurally identical to `@cascade/storage`'s `SpanRecord` ON PURPOSE — core
 *  must not depend on the storage package (nor storage on core), and a type-level test asserts the two
 *  stay mutually assignable so the duplication cannot drift. */
export interface TraceSpan {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  /** 'AGENT' | 'LLM' | 'TOOL' | 'CHAIN' — the OpenInference span kinds we emit. */
  kind: string
  startedAt: number
  /** Absent ⇒ still OPEN. Present ⇒ this record closes the span. */
  endedAt?: number
  status?: 'ok' | 'error'
  attributes?: Record<string, unknown>
}

/** Readable names for the notable moments. The raw event id (`slow_prefill`) says nothing on a
 *  waterfall; the label carries the KEY DATUM inline so the row is legible without being clicked. */
const MARK_LABELS: Record<string, (e: Record<string, unknown>) => string> = {
  compaction: (e) => `compaction (${e.kind})`,
  delegate_nudge: () => 'nudge: delegate',
  verify_gate: () => 'gate: verify',
  plan_nudge: () => 'nudge: plan first',
  todo_gate: (e) => `gate: ${e.open} todo${e.open === 1 ? '' : 's'} still open`,
  read_loop: (e) => `nudge: read loop (${e.path})`,
  re_edit: (e) => `nudge: re-edit → use Grep/Lsp (${e.path})`,
  narration_loop: () => 'nudge: narration loop — change strategy',
  repeat_call: (e) => `nudge: repeat call (${e.tool})`,
  tool_cap: (e) => `cap: ${e.calls} tool calls — converge or report`,
  recall: (e) => `recall: ${e.count} memories surfaced`,
  stalled_verify: () => 'nudge: stalled verify',
  post_edit_check: (e) => `post-edit check: errors in ${e.files} file${e.files === 1 ? '' : 's'}`,
  degraded_retry: () => 'degraded response — retried',
  degenerate_cut: (e) => `cut: degenerate output loop (${e.chars} chars)`,
  planning_stall: () => 'nudge: planning stall → execute now',
  max_tokens_cut: () => 'max-tokens cut — act-now nudge',
  slow_prefill: (e) => `slow prefill (${Math.round(Number(e.waitedMs) / 1000)}s)`,
  hook: (e) => `hook ${e.event} → ${e.decision}`,
  error: () => 'error',
}

const CAP = 4_000 // attribute payload cap — viewers truncate anyway; keep spans light
const cut = (s: unknown): string => String(s ?? '').slice(0, CAP)

// Span/trace ids must be unique ACROSS PROCESSES, not just within one. The first version was
// `counter + last-4-of-Date.now()`, which restarts the counter on every launch and only carries ~28
// minutes of clock in those four base-36 digits — so two runs close together mint the SAME ids. The store
// upserts by span id, so a colliding span silently OVERWRITES an unrelated older one: measured, 150
// seeded turns landed as 147 rows, and the three that vanished did so with no error anywhere.
// A per-process random prefix plus a monotonic counter removes the clock from the equation entirely.
const RUN = Math.random().toString(36).slice(2, 8)
let counter = 0
const newId = (p: string) => `${p}${RUN}${(++counter).toString(36)}`

export interface SpanFoldOptions {
  /** PIN the trace id (tests, replay/backfill). Omit in the product: every submit mints its own, because
   *  a TRACE is one turn — a session lives for days, and lumping its turns together gives one
   *  ever-growing trace with N roots instead of the per-turn waterfall you actually read. */
  traceId?: string
  /** Stamped on every span so a viewer can filter by project without a join. The project ID, never a
   *  host path — these records are read back by clients. */
  projectId?: string
  model?: string
  /** Names the root, e.g. 'agent (builder)' / 'agent (planner)'. One prompt on a fresh project yields
   *  both a planner turn and a builder turn; with both roots called "agent" they are indistinguishable. */
  rootName?: string
  now?: () => number
  /** Set by `subAgent()`: this fold nests INSIDE another's trace instead of starting one. Returns the
   *  parent's live trace + root span, read at submit time because the parent's turn changes under it. */
  parentTurn?: () => { traceId: string; spanId: string } | undefined
  /** Set by `subAgent()`: read the CHAT from the parent rather than holding one. A sub-agent that kept its
   *  own would start unattributed — its spans would sit in the turn but outside the conversation, so
   *  "everything in this chat" would quietly miss the planner's work. */
  sessionOf?: () => string | undefined
}

/** What a sink implements: receive span records (open and close) as they are produced. */
export type SpanSink = (span: TraceSpan) => void

export interface SpanTracer extends Tracer {
  /**
   * A tracer for a SUB-AGENT of this one: its root becomes a child AGENT span inside this fold's
   * current trace, rather than a trace of its own.
   *
   * This is what the conventions call for. OTel's GenAI semconv models a same-process agent invocation
   * as an INTERNAL `invoke_agent` span, and general OTel rules make a nested operation a child span —
   * so a sub-agent belongs in its parent's trace. The tools agree emphatically: Langfuse propagates a
   * trace id across SERVICE boundaries (and will derive it from a shared seed) specifically so a
   * supervisor delegating to a separate agent service still reconstructs as one tree. Two sessions in
   * one process producing two traces was an artifact of their having two tracers, not a decision.
   *
   * Cascade's orchestrated plan stage is exactly this case: one user message, planner then builder.
   * A model-invoked `Subagent {agent:"planner"}` already nests (it shares the parent's tracer); this
   * makes the orchestrated path identical.
   */
  subAgent(name: string): Tracer
  /**
   * Open this turn's root span NOW, before the session itself submits.
   *
   * The orchestrated plan stage runs to completion BEFORE the builder submits, so without this there is
   * no root for it to nest under and it would start a trace of its own — which is exactly the artifact
   * being removed. The server opens the turn, the plan stage nests inside it, and the builder's own
   * `submit` then ADOPTS the open root rather than starting a second one.
   *
   * Idempotent-ish: a second beginTurn closes the first as interrupted, same as a second submit would.
   */
  beginTurn(text: string): void
  /** Bind following turns to a CHAT. Every submit is its own trace by design, so without this a build and
   *  its follow-ups arrive as unrelated traces with nothing tying them to the conversation they came from
   *  — and "show me what this chat actually did" is unanswerable. Set per submit, because a session's
   *  active chat can change under it (loadChat switches chats without rebuilding the session). */
  setSession(chatId: string | undefined): void
  /** End everything still open because the PROCESS is going down. A hard exit never runs the loop's
   *  `finally`, so `turn_done` never fires — and an open span otherwise reads as RUNNING FOREVER in the
   *  Observatory (and is never exported at all over OTLP). This turns "gone" into "interrupted", which
   *  is a fact you can act on. */
  endOpenSpans(reason: string): void
}

/**
 * Build a Tracer that folds the event stream into spans and hands each to `emit`.
 *
 * One instance per SESSION (same lifetime rule as JsonlTracer): it holds that session's open spans.
 */
export function createSpanTracer(emit: SpanSink, opts: SpanFoldOptions = {}): SpanTracer {
  const now = opts.now ?? (() => Date.now())
  let traceId = opts.traceId ?? newId('t')
  const rootName = opts.rootName ?? 'agent'
  let chatId: string | undefined
  // Read at WRITE time, not captured: the chat can change mid-session, and the id must land on every span
  // rather than only the root — the root is the last thing to close, so a live turn would be unattributed
  // for exactly as long as it is still interesting.
  const base = () => ({ 'cascade.project_id': opts.projectId, 'cascade.model': opts.model, 'cascade.chat_id': opts.sessionOf ? opts.sessionOf() : chatId }) as Record<string, unknown>

  let rootId: string | undefined
  let rootStart = 0
  // Carried so the CLOSE record repeats it: the SQLite sink upserts only end/status/attributes, but the
  // OTLP sink acts on the close and needs to know where to hang the span.
  let rootParent: string | undefined
  // Attributes are carried forward because a sink that upserts REPLACES the attribute blob: closing a
  // span without re-sending its open-time fields erases them. That cost us the user's own prompt off
  // every finished trace once already — the root's `input`, written at submit and wiped at turn_done.
  let rootAttrs: Record<string, unknown> = {}
  // Set by beginTurn: the next `submit` belongs to the root we already opened, so it must adopt rather
  // than close-and-reopen (which would orphan anything the plan stage already nested inside it).
  let adopting = false
  let llm: { spanId: string; start: number; turn: number; attrs: Record<string, unknown> } | undefined
  const tools = new Map<string, { spanId: string; start: number; name: string; attrs: Record<string, unknown> }>()
  // Permission decisions arrive BEFORE the tool span exists, so they wait here and ride on the call they
  // authorised — one span per call, not two (measured: 178 permission events in a single build, enough
  // to bury the actual work in the waterfall).
  const pendingPermission = new Map<string, Record<string, unknown>>()
  let window: number | undefined

  const write = (s: Omit<TraceSpan, 'traceId'>) => emit({ traceId, ...s, attributes: { ...base(), ...s.attributes } })

  const closeOpen = (at: number, reason?: string) => {
    for (const [, t] of tools) {
      write({ spanId: t.spanId, parentSpanId: rootId, name: `tool ${t.name}`, kind: 'TOOL', startedAt: t.start, endedAt: at, status: reason ? 'error' : 'ok', attributes: { ...t.attrs, ...(reason ? { 'cascade.interrupted': reason } : {}) } })
    }
    tools.clear()
    if (llm) {
      write({ spanId: llm.spanId, parentSpanId: rootId, name: `llm turn ${llm.turn}`, kind: 'LLM', startedAt: llm.start, endedAt: at, status: reason ? 'error' : 'ok', attributes: { ...llm.attrs, ...(reason ? { 'cascade.interrupted': reason } : {}) } })
      llm = undefined
    }
    if (rootId) {
      write({ spanId: rootId, parentSpanId: rootParent, name: rootName, kind: 'AGENT', startedAt: rootStart, endedAt: at, status: reason ? 'error' : 'ok', attributes: { ...rootAttrs, ...(reason ? { 'cascade.interrupted': reason } : {}) } })
      rootId = undefined
      rootParent = undefined
      rootAttrs = {}
    }
  }

  return {
    beginTurn(text: string): void {
      const at = now()
      closeOpen(at, 'interrupted')
      if (!opts.traceId) traceId = newId('t')
      rootId = newId('s')
      rootStart = at
      rootParent = undefined
      rootAttrs = { input: cut(text) }
      adopting = true
      write({ spanId: rootId, name: rootName, kind: 'AGENT', startedAt: at, attributes: rootAttrs })
    },

    subAgent(name: string): Tracer {
      // Reads the parent's CURRENT turn at submit time, not at construction: the plan stage's tracer is
      // built partway through a submit, and a tracer built between turns would otherwise capture nothing.
      return createSpanTracer(emit, {
        ...opts,
        rootName: name,
        traceId: undefined,
        parentTurn: () => (rootId ? { traceId, spanId: rootId } : undefined),
        sessionOf: () => (opts.sessionOf ? opts.sessionOf() : chatId),
      })
    },

    setSession(id: string | undefined): void {
      chatId = id || undefined
    },

    endOpenSpans(reason: string): void {
      adopting = false
      closeOpen(now(), reason)
    },

    event(raw: TraceEvent): void {
      const e = raw as unknown as Record<string, unknown> & { t: string; ts?: string }
      const at = e.ts ? Date.parse(e.ts) : now()

      switch (e.t) {
        case 'submit': {
          // The server already opened this turn (see beginTurn) — adopt it. Closing and reopening here
          // would strand whatever the plan stage nested inside the root it was given.
          if (adopting) {
            adopting = false
            rootAttrs = { ...rootAttrs, input: cut(e.text) }
            break
          }
          // A previous turn that never terminated (a crash between its last event and `turn_done`) would
          // be stranded open forever if we simply overwrote the root.
          closeOpen(at, 'interrupted')
          // NESTED: join the parent's trace and hang this agent's root off the parent's, rather than
          // starting a trace of our own. `gen_ai.operation.name = invoke_agent`, INTERNAL kind.
          const parent = opts.parentTurn?.()
          if (parent) traceId = parent.traceId
          else if (!opts.traceId) traceId = newId('t') // one trace per TURN — a session spans days
          rootId = newId('s')
          rootStart = at
          rootParent = parent?.spanId
          rootAttrs = { input: cut(e.text), ...(parent ? { 'gen_ai.operation.name': 'invoke_agent' } : {}) }
          write({ spanId: rootId, parentSpanId: parent?.spanId, name: rootName, kind: 'AGENT', startedAt: at, attributes: rootAttrs })
          break
        }

        case 'model_request': {
          window = e.contextWindow as number | undefined
          llm = {
            spanId: newId('l'),
            start: at,
            turn: (e.turn as number) ?? 0,
            attrs: {
              provider: e.provider,
              model: e.model,
              contextWindow: window,
              // WHAT WE ACTUALLY SENT. The Observatory had output only, which answers "what did it say"
              // but never "what was it looking at" — and with a weak model the second question is the
              // one that explains the first. Last two messages: the whole transcript would be megabytes.
              input: cut(JSON.stringify((e.messages as unknown[])?.slice(-2) ?? [])),
              toolsOffered: (e.tools as string[])?.length,
            },
          }
          write({ spanId: llm.spanId, parentSpanId: rootId, name: `llm turn ${llm.turn}`, kind: 'LLM', startedAt: at, attributes: llm.attrs })
          break
        }

        case 'model_response': {
          if (!llm) break
          const u = (e.usage ?? {}) as Record<string, number>
          const toolUses = (e.toolUses ?? []) as { name: string }[]
          const text = String(e.text ?? '')
          write({
            spanId: llm.spanId,
            parentSpanId: rootId,
            name: `llm turn ${llm.turn}`,
            kind: 'LLM',
            startedAt: llm.start,
            endedAt: at,
            status: 'ok',
            attributes: {
              ...llm.attrs,
              // On a TOOL-ONLY turn `text` is empty, so output degrades to the tool list — and the
              // reasoning that chose those tools is the thing you need when a local model goes somewhere
              // strange. Keep them as separate fields so a viewer can render reasoning as reasoning.
              output: cut(text || `(tools: ${toolUses.map((t) => t.name).join(', ') || 'none'})`),
              thinking: cut(e.thinking),
              toolUses: toolUses.map((t) => t.name).join(', ') || undefined,
              inputTokens: u.inputTokens,
              outputTokens: u.outputTokens,
              latencyMs: at - llm.start,
              // Prefill/decode split — the KV-CACHE observable. Prompt token COUNTS include cached
              // tokens, so a cache miss shows up ONLY here: prefill_tps collapsing to ~500 tok/s means a
              // full re-prefill, a hit runs 10k+. Duration alone cannot tell those apart.
              promptEvalMs: u.promptEvalMs,
              prefillTps: u.promptEvalMs ? Math.round(((u.inputTokens ?? 0) / u.promptEvalMs) * 1000) : undefined,
              decodeMs: u.decodeMs,
              decodeTps: u.decodeMs ? Math.round((((u.outputTokens ?? 0) / u.decodeMs) * 1000 + Number.EPSILON) * 10) / 10 : undefined,
              // A nonzero load mid-session means the RUNNER itself was evicted and reloaded — which
              // looks exactly like a slow model until you can see this number.
              modelLoadMs: u.loadMs && u.loadMs > 500 ? u.loadMs : undefined,
            },
          })
          llm = undefined
          break
        }

        case 'permission':
          pendingPermission.set(String(e.id), { 'cascade.permission': e.decision, 'cascade.permission_asked': e.asked })
          break

        case 'tool_call': {
          const id = String(e.id)
          const attrs: Record<string, unknown> = {
            toolName: e.name,
            input: cut(JSON.stringify(e.input ?? {})),
            ...(pendingPermission.get(id) ?? {}),
            // The harness had to REPAIR the model's tool arguments to make this call runnable — a direct
            // weak-model signal, on the exact call where it happened.
            ...(e.repaired ? { argsRepaired: true } : {}),
          }
          pendingPermission.delete(id)
          const spanId = newId('x')
          tools.set(id, { spanId, start: at, name: String(e.name), attrs })
          write({ spanId, parentSpanId: rootId, name: `tool ${e.name}`, kind: 'TOOL', startedAt: at, attributes: attrs })
          break
        }

        case 'tool_result': {
          const open = tools.get(String(e.id))
          if (!open) break
          tools.delete(String(e.id))
          write({
            spanId: open.spanId,
            parentSpanId: rootId,
            name: `tool ${open.name}`,
            kind: 'TOOL',
            startedAt: open.start,
            // The event's own ms is authoritative: it measures the TOOL, not our bookkeeping.
            endedAt: open.start + (typeof e.ms === 'number' ? e.ms : at - open.start),
            status: e.ok === false ? 'error' : 'ok',
            attributes: { ...open.attrs, output: cut(e.content), durationMs: e.ms },
          })
          break
        }

        case 'turn_done': {
          // STRAGGLERS FIRST. A turn can end with an LLM call or tool still open — a backfill replaying a
          // truncated .jsonl, or a real turn cut short. Closing only the root would leave them open
          // forever: perpetually "running" in the Observatory, and never exported at all over OTLP.
          rootAttrs = { ...rootAttrs, turns: e.turns }
          closeOpen(at)
          break
        }

        default: {
          const label = MARK_LABELS[e.t]
          if (!label) break
          const { t, ts, ...rest } = e
          // Zero-duration, so a gate firing lands on the waterfall at the instant it happened. Status is
          // left UNSET for anything but an error: a read loop is a NOTICE, and a green tick beside
          // "nudge: read loop" reads as "this went well" on the row that says it didn't.
          write({
            spanId: newId('m'),
            // Anchored to the LLM call when one is in flight — a nudge fired mid-generation belongs
            // under the generation that provoked it.
            parentSpanId: llm?.spanId ?? rootId,
            name: label(rest),
            kind: 'CHAIN',
            startedAt: at,
            endedAt: at,
            status: t === 'error' ? 'error' : undefined,
            attributes: { ...rest, markKind: t },
          })
          if (t === 'error') rootAttrs = { ...rootAttrs, 'cascade.error': cut(e.message) }
          break
        }
      }
    },
  }
}
