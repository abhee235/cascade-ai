// The ONE event→span fold (ADR-081 amendment). Every viewer is a sink over this, so a gap here is a gap
// in Phoenix AND in the Observatory — which is exactly the property the amendment bought.
import { describe, it, expect } from 'vitest'
import { createSpanTracer, type TraceSpan } from '../src/observability/spanFold'

/** Collect emitted spans, keeping only the LATEST record per span id (what an upserting store holds). */
function collect() {
  const all: TraceSpan[] = []
  const tracer = createSpanTracer((s) => all.push({ ...s, attributes: { ...s.attributes } }), { traceId: 'T', projectId: 'p1', model: 'qwen', rootName: 'agent (builder)' })
  const emit = (e: Record<string, unknown>) => tracer.event(e as never)
  const latest = () => {
    const m = new Map<string, TraceSpan>()
    for (const s of all) m.set(s.spanId, s)
    return [...m.values()]
  }
  return { tracer, emit, all, latest, byKind: (k: string) => latest().filter((s) => s.kind === k), names: () => latest().map((s) => s.name) }
}

describe('spanFold — structure', () => {
  it('builds root → LLM / TOOL with the right parents and kinds', () => {
    const c = collect()
    c.emit({ t: 'submit', text: 'build me a shop' })
    c.emit({ t: 'model_request', turn: 0, provider: 'ollama', model: 'qwen', messages: [] })
    c.emit({ t: 'model_response', turn: 0, text: 'ok', usage: { inputTokens: 10, outputTokens: 3 } })
    c.emit({ t: 'tool_call', id: 'c1', name: 'Write', input: { file_path: 'a.ts' } })
    c.emit({ t: 'tool_result', id: 'c1', name: 'Write', ok: true, ms: 12, content: 'wrote' })
    c.emit({ t: 'turn_done', turns: 1 })

    const root = c.byKind('AGENT')[0]
    expect(root.name).toBe('agent (builder)')
    expect(root.parentSpanId).toBeUndefined()
    expect(root.endedAt).toBeDefined()
    for (const kind of ['LLM', 'TOOL']) {
      const s = c.byKind(kind)[0]
      expect(s.parentSpanId).toBe(root.spanId)
      expect(s.endedAt).toBeDefined()
    }
  })

  it('emits each span TWICE — open then close — so a live turn is visible while it runs', () => {
    const c = collect()
    c.emit({ t: 'submit', text: 'x' })
    c.emit({ t: 'tool_call', id: 'c1', name: 'Bash' })
    // Before the result arrives, the store already has an OPEN tool span.
    expect(c.all.filter((s) => s.kind === 'TOOL')).toHaveLength(1)
    expect(c.all.find((s) => s.kind === 'TOOL')?.endedAt).toBeUndefined()
    c.emit({ t: 'tool_result', id: 'c1', name: 'Bash', ok: true, ms: 5, content: '' })
    expect(c.all.filter((s) => s.kind === 'TOOL')).toHaveLength(2) // …then its close, same span id
    expect(c.byKind('TOOL')[0].endedAt).toBeDefined()
  })

  it('uses the tool result ms as the duration, not wall-clock bookkeeping', () => {
    const c = collect()
    c.emit({ t: 'submit', text: 'x' })
    c.emit({ t: 'tool_call', id: 'c1', name: 'Bash' })
    c.emit({ t: 'tool_result', id: 'c1', name: 'Bash', ok: true, ms: 4321, content: '' })
    const tool = c.byKind('TOOL')[0]
    expect((tool.endedAt ?? 0) - tool.startedAt).toBe(4321)
  })

  it('interleaved tool calls close against their OWN id', () => {
    const c = collect()
    c.emit({ t: 'submit', text: 'x' })
    c.emit({ t: 'tool_call', id: 'a', name: 'Read' })
    c.emit({ t: 'tool_call', id: 'b', name: 'Glob' })
    c.emit({ t: 'tool_result', id: 'b', name: 'Glob', ok: true, ms: 5, content: '' })
    c.emit({ t: 'tool_result', id: 'a', name: 'Read', ok: true, ms: 50, content: '' })
    const by = Object.fromEntries(c.byKind('TOOL').map((t) => [t.name, (t.endedAt ?? 0) - t.startedAt]))
    expect(by['tool Glob']).toBe(5)
    expect(by['tool Read']).toBe(50)
  })

  it('mints ids that do not collide across tracer instances', () => {
    // Measured in the running app: 150 seeded turns landed as 147 rows. The id was a per-process counter
    // plus the last four base-36 digits of Date.now() — the counter restarts each launch and four digits
    // only carry ~28 minutes of clock, so two runs close together minted identical ids. The store upserts
    // by span id, so the collisions silently OVERWROTE unrelated spans, with no error anywhere.
    const ids = new Set<string>()
    for (let i = 0; i < 50; i++) {
      const t = createSpanTracer((s) => {
        ids.add(s.spanId)
        ids.add(s.traceId)
      })
      t.event({ t: 'submit', text: 'x' } as never)
      t.event({ t: 'tool_call', id: 'a', name: 'Read' } as never)
      t.event({ t: 'turn_done', turns: 1 } as never)
    }
    expect(ids.size).toBe(50 * 3) // 50 traces × (trace id + root span + tool span)
  })

  it('gives every submit its OWN trace — a trace is a turn, not a session', () => {
    const all: TraceSpan[] = []
    const tracer = createSpanTracer((s) => all.push(s), { projectId: 'p1' }) // unpinned: the product path
    for (const text of ['first', 'second']) {
      tracer.event({ t: 'submit', text } as never)
      tracer.event({ t: 'turn_done', turns: 1 } as never)
    }
    expect(new Set(all.map((s) => s.traceId)).size).toBe(2)
  })
})

describe('spanFold — sub-agents nest, they do not fork the trace', () => {
  // OTel's GenAI semconv models a same-process agent invocation as an INTERNAL `invoke_agent` span, and
  // general OTel rules make a nested operation a child span. Langfuse/LangSmith go further and propagate
  // trace ids across SERVICE boundaries to keep one tree. Two sessions in one process producing two
  // traces was an artifact of their having two tracers — this is the contract that stops it recurring.
  const nested = () => {
    const all: TraceSpan[] = []
    const parent = createSpanTracer((s) => all.push({ ...s, attributes: { ...s.attributes } }), { projectId: 'p1', rootName: 'agent (builder)' })
    const latest = () => {
      const m = new Map<string, TraceSpan>()
      for (const s of all) m.set(s.spanId, s)
      return [...m.values()]
    }
    return { parent, all, latest }
  }

  it('the server can open the turn BEFORE the session submits, and submit adopts it', () => {
    // The plan stage runs to completion before the builder submits, so the turn must exist first or the
    // planner has nothing to nest under — which is exactly how it became a separate trace.
    const c = nested()
    c.parent.beginTurn('build a shop')
    const opened = c.latest().filter((s) => s.kind === 'AGENT')
    expect(opened).toHaveLength(1)
    c.parent.event({ t: 'submit', text: 'build a shop' } as never)
    c.parent.event({ t: 'turn_done', turns: 1 } as never)
    const roots = c.latest().filter((s) => s.kind === 'AGENT')
    expect(roots).toHaveLength(1) // ADOPTED, not closed-and-reopened
    expect(roots[0].endedAt).toBeDefined()
    expect(roots[0].attributes?.input).toBe('build a shop')
  })

  it('a sub-agent becomes a CHILD span in the same trace', () => {
    const c = nested()
    c.parent.beginTurn('build a shop')
    const planner = c.parent.subAgent('agent (planner)')
    planner.event({ t: 'submit', text: 'plan it' } as never)
    planner.event({ t: 'model_request', turn: 0, messages: [] } as never)
    planner.event({ t: 'model_response', turn: 0, text: 'PLAN.md written' } as never)
    planner.event({ t: 'turn_done', turns: 1 } as never)
    c.parent.event({ t: 'submit', text: 'build a shop' } as never)
    c.parent.event({ t: 'turn_done', turns: 3 } as never)

    const spans = c.latest()
    expect(new Set(spans.map((s) => s.traceId)).size).toBe(1) // ONE trace for one user message
    const root = spans.find((s) => s.kind === 'AGENT' && !s.parentSpanId)!
    const sub = spans.find((s) => s.name === 'agent (planner)')!
    expect(root.name).toBe('agent (builder)')
    expect(sub.parentSpanId).toBe(root.spanId)
    expect(sub.attributes?.['gen_ai.operation.name']).toBe('invoke_agent')
    // The sub-agent's OWN work hangs off the sub-agent. Nesting only the agent span would be cosmetic.
    expect(spans.find((s) => s.kind === 'LLM')?.parentSpanId).toBe(sub.spanId)
  })

  it('a sub-agent inherits the CHAT — otherwise its work falls outside the conversation', () => {
    // Caught by the end-to-end test: subAgent builds a fresh fold, and the chat lived in the parent's
    // closure, so the planner's spans sat inside the turn but outside the conversation.
    const c = nested()
    c.parent.setSession('chat-abc')
    c.parent.beginTurn('x')
    const sub = c.parent.subAgent('agent (planner)')
    sub.event({ t: 'submit', text: 'plan' } as never)
    expect(c.latest().every((s) => s.attributes?.['cascade.chat_id'] === 'chat-abc')).toBe(true)
  })

  it('a sub-agent with no open parent turn still records, as its own trace', () => {
    // The eval bench builds plan sessions directly, with no builder turn around them. Losing those spans
    // would be worse than not nesting them.
    const c = nested()
    const orphan = c.parent.subAgent('agent (planner)')
    orphan.event({ t: 'submit', text: 'plan' } as never)
    const sub = c.latest().find((s) => s.name === 'agent (planner)')!
    expect(sub).toBeDefined()
    expect(sub.parentSpanId).toBeUndefined()
  })
})

describe('spanFold — the observables diagnosis depends on', () => {
  it('records the PROMPT, not just the answer', () => {
    // The Observatory shipped with output only. "What was the model looking at" is the question that
    // explains a weak model's behaviour, and it had no answer in-app.
    const c = collect()
    c.emit({ t: 'submit', text: 'x' })
    c.emit({ t: 'model_request', turn: 0, provider: 'ollama', model: 'q', messages: [{ role: 'user', content: 'add a filter' }] })
    expect(String(c.byKind('LLM')[0].attributes?.input)).toContain('add a filter')
  })

  it('keeps reasoning separate from text, and names the tools on a tool-only turn', () => {
    const c = collect()
    c.emit({ t: 'submit', text: 'x' })
    c.emit({ t: 'model_request', turn: 0, messages: [] })
    c.emit({ t: 'model_response', turn: 0, text: '', thinking: 'check useCart first', toolUses: [{ name: 'Read' }, { name: 'Grep' }] })
    const a = c.byKind('LLM')[0].attributes!
    expect(a.thinking).toBe('check useCart first')
    // Without this the output would be empty and the reasoning that chose the tools would be all there is.
    expect(a.output).toBe('(tools: Read, Grep)')
    expect(a.toolUses).toBe('Read, Grep')
  })

  it('derives prefill and decode throughput — the KV-cache observable', () => {
    // Prompt token COUNTS include cached tokens, so a cache miss shows up ONLY as collapsed prefill
    // throughput (~500 tok/s = full re-prefill vs 10k+ on a hit). Raw ms cannot distinguish them.
    const c = collect()
    c.emit({ t: 'submit', text: 'x' })
    c.emit({ t: 'model_request', turn: 0, contextWindow: 131072, messages: [] })
    c.emit({ t: 'model_response', turn: 0, text: 'y', usage: { inputTokens: 44210, outputTokens: 512, promptEvalMs: 8600, decodeMs: 16400, loadMs: 2400 } })
    const a = c.byKind('LLM')[0].attributes!
    expect(a.prefillTps).toBe(Math.round((44210 / 8600) * 1000))
    expect(a.decodeTps).toBe(31.2)
    expect(a.modelLoadMs).toBe(2400) // the runner itself was evicted and reloaded
    expect(a.contextWindow).toBe(131072)
  })

  it('ignores a trivial model load — only a real reload is worth a field', () => {
    const c = collect()
    c.emit({ t: 'submit', text: 'x' })
    c.emit({ t: 'model_request', turn: 0, messages: [] })
    c.emit({ t: 'model_response', turn: 0, text: 'y', usage: { inputTokens: 1, outputTokens: 1, loadMs: 40 } })
    expect(c.byKind('LLM')[0].attributes?.modelLoadMs).toBeUndefined()
  })

  it('folds the permission decision ONTO the call it authorised', () => {
    // One span per call, not two: a build measured 178 permission events, enough to bury the real work.
    const c = collect()
    c.emit({ t: 'submit', text: 'x' })
    c.emit({ t: 'permission', id: 'a', tool: 'Bash', decision: 'allow', asked: true })
    c.emit({ t: 'tool_call', id: 'a', name: 'Bash', input: {} })
    const a = c.byKind('TOOL')[0].attributes!
    expect(a['cascade.permission']).toBe('allow')
    expect(a['cascade.permission_asked']).toBe(true)
  })

  it('flags a call whose arguments the harness had to REPAIR', () => {
    const c = collect()
    c.emit({ t: 'submit', text: 'x' })
    c.emit({ t: 'tool_call', id: 'a', name: 'Edit', input: {}, repaired: true })
    expect(c.byKind('TOOL')[0].attributes?.argsRepaired).toBe(true)
  })

  it('stamps the chat on EVERY span, not just the root', () => {
    // The root closes last, so a chat id set only there would leave a live turn unattributed for exactly
    // as long as it is still interesting — and the Observatory could not offer "open chat" until it ended.
    const c = collect()
    c.tracer.setSession('chat-abc')
    c.emit({ t: 'submit', text: 'x' })
    c.emit({ t: 'tool_call', id: 'a', name: 'Read' })
    expect(c.latest().every((s) => s.attributes?.['cascade.chat_id'] === 'chat-abc')).toBe(true)
  })

  it('a chat switch re-attributes FOLLOWING turns, and clearing stops stamping', () => {
    // loadChat switches the active chat without rebuilding the session, so the tracer outlives the chat.
    const c = collect()
    c.tracer.setSession('chat-one')
    c.emit({ t: 'submit', text: 'a' })
    c.emit({ t: 'turn_done', turns: 1 })
    c.tracer.setSession('chat-two')
    c.emit({ t: 'submit', text: 'b' })
    c.emit({ t: 'turn_done', turns: 1 })
    c.tracer.setSession(undefined)
    c.emit({ t: 'submit', text: 'c' })
    c.emit({ t: 'turn_done', turns: 1 })
    expect(c.byKind('AGENT').map((s) => s.attributes?.['cascade.chat_id'])).toEqual(['chat-one', 'chat-two', undefined])
  })

  it('KEEPS the submit text on the root after the turn closes', () => {
    // A sink that upserts replaces the attribute blob, so closing the root would erase the prompt written
    // when it opened — losing the user's own words from every finished trace, on the span you land on first.
    const c = collect()
    c.emit({ t: 'submit', text: 'Build a recipe app' })
    c.emit({ t: 'turn_done', turns: 3 })
    const root = c.byKind('AGENT')[0].attributes!
    expect(root.input).toBe('Build a recipe app')
    expect(root.turns).toBe(3)
  })
})

describe('spanFold — notable moments', () => {
  // The list that diverged: SIX of these reached Phoenix but not the Observatory, THREE the reverse.
  const MOMENTS: [Record<string, unknown>, string][] = [
    [{ t: 'compaction', kind: 'masked', tokensBefore: 90000, tokensAfter: 30000 }, 'compaction (masked)'],
    [{ t: 'slow_prefill', turn: 0, waitedMs: 185_000 }, 'slow prefill (185s)'],
    [{ t: 'post_edit_check', turn: 0, files: 2 }, 'post-edit check: errors in 2 files'],
    [{ t: 'read_loop', turn: 0, path: 'src/App.tsx' }, 'nudge: read loop (src/App.tsx)'],
    [{ t: 're_edit', turn: 0, path: 'a.ts' }, 'nudge: re-edit → use Grep/Lsp (a.ts)'],
    [{ t: 'todo_gate', turn: 0, open: 3 }, 'gate: 3 todos still open'],
    [{ t: 'verify_gate', turn: 0 }, 'gate: verify'],
    [{ t: 'stalled_verify', turn: 0 }, 'nudge: stalled verify'],
    [{ t: 'degraded_retry', turn: 0 }, 'degraded response — retried'],
    [{ t: 'recall', turn: 0, count: 3 }, 'recall: 3 memories surfaced'],
    [{ t: 'max_tokens_cut', turn: 0 }, 'max-tokens cut — act-now nudge'],
    [{ t: 'narration_loop', turn: 0 }, 'nudge: narration loop — change strategy'],
    [{ t: 'repeat_call', turn: 0, tool: 'Read' }, 'nudge: repeat call (Read)'],
    [{ t: 'tool_cap', turn: 0, calls: 100 }, 'cap: 100 tool calls — converge or report'],
    [{ t: 'delegate_nudge', turn: 0, readTokens: 40000 }, 'nudge: delegate'],
    [{ t: 'plan_nudge', turn: 0 }, 'nudge: plan first'],
    [{ t: 'degenerate_cut', turn: 0, chars: 18600 }, 'cut: degenerate output loop (18600 chars)'],
    [{ t: 'planning_stall', turn: 0, idle: 5 }, 'nudge: planning stall → execute now'],
    [{ t: 'hook', event: 'PreToolUse', id: 'h', tool: 'Bash', decision: 'allow', ms: 12 }, 'hook PreToolUse → allow'],
  ]

  it.each(MOMENTS)('%o renders as a readable mark', (event, label) => {
    const c = collect()
    c.emit({ t: 'submit', text: 'x' })
    c.emit(event)
    const mark = c.byKind('CHAIN')[0]
    // The label carries the key datum INLINE, so the row is legible on a waterfall without being clicked.
    expect(mark?.name).toBe(label)
    expect(mark.endedAt).toBe(mark.startedAt) // zero-duration: it happened at an instant
    expect(mark.attributes?.markKind).toBe(event.t) // the raw id survives for filtering
  })

  it('leaves a non-error mark WITHOUT a status — a breaker is a notice, not a success', () => {
    const c = collect()
    c.emit({ t: 'submit', text: 'x' })
    c.emit({ t: 'read_loop', turn: 1, path: 'a.ts' })
    c.emit({ t: 'error', message: 'boom' })
    const marks = c.byKind('CHAIN')
    expect(marks.find((m) => m.attributes?.markKind === 'read_loop')?.status).toBeUndefined()
    expect(marks.find((m) => m.attributes?.markKind === 'error')?.status).toBe('error')
  })

  it('anchors a mark to the LLM call in flight — a nudge belongs under what provoked it', () => {
    const c = collect()
    c.emit({ t: 'submit', text: 'x' })
    c.emit({ t: 'model_request', turn: 0, messages: [] })
    c.emit({ t: 'slow_prefill', turn: 0, waitedMs: 1000 })
    expect(c.byKind('CHAIN')[0].parentSpanId).toBe(c.byKind('LLM')[0].spanId)
  })

  it('ignores unremarkable events rather than flooding the trace', () => {
    const c = collect()
    c.emit({ t: 'submit', text: 'x' })
    c.emit({ t: 'something_new_and_unmapped', turn: 1 })
    expect(c.byKind('CHAIN')).toHaveLength(0)
  })
})

describe('spanFold — turns that do not finish cleanly', () => {
  it('endOpenSpans records an INTERRUPTED turn, stragglers and all', () => {
    // Without this a crashed turn stays open forever: perpetually "running" in the Observatory, and never
    // exported at all over OTLP. Measured: six of seven turns in one session vanished to dev-server restarts.
    const c = collect()
    c.emit({ t: 'submit', text: 'a long build' })
    c.emit({ t: 'model_request', turn: 0, messages: [] })
    c.emit({ t: 'tool_call', id: 't1', name: 'Write', input: {} })
    c.tracer.endOpenSpans('server shutdown')

    for (const kind of ['AGENT', 'LLM', 'TOOL']) {
      const s = c.byKind(kind)[0]
      expect(s.endedAt, `${kind} must be closed`).toBeDefined()
      expect(s.attributes?.['cascade.interrupted']).toBe('server shutdown')
      expect(s.status).toBe('error') // it must not read as a clean finish
    }
  })

  it('turn_done closes an LLM straggler, not just the root', () => {
    // A backfill replaying a truncated .jsonl injects turn_done synthetically; the open LLM call must not
    // be left dangling behind a closed root.
    const c = collect()
    c.emit({ t: 'submit', text: 'one' })
    c.emit({ t: 'model_request', turn: 0, messages: [] })
    c.emit({ t: 'turn_done', turns: 0 })
    expect(c.byKind('LLM')[0].endedAt).toBeDefined()
    expect(c.byKind('AGENT')[0].endedAt).toBeDefined()
  })

  it('a new submit closes a previous turn that never terminated', () => {
    const c = collect()
    c.emit({ t: 'submit', text: 'first' })
    c.emit({ t: 'submit', text: 'second' }) // no turn_done in between — a crash, or a restarted session
    const roots = c.byKind('AGENT')
    expect(roots).toHaveLength(2)
    expect(roots[0].attributes?.['cascade.interrupted']).toBe('interrupted')
    expect(roots[0].endedAt).toBeDefined()
  })
})
