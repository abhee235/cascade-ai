// ADR-053 — the event-stream → OTel span mapping, asserted against an in-memory exporter (no network).
import { describe, expect, it } from 'vitest'
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { OtelTracer } from './otelTracer.mts'

/** Build a tracer that exports into memory via the injectable processor seam (no network, no reach-ins). */
function memoryTracer(): { tracer: OtelTracer; exporter: InMemorySpanExporter } {
	const exporter = new InMemorySpanExporter()
	const tracer = new OtelTracer({ endpoint: 'http://unused.invalid/v1/traces', service: 'test', processor: new SimpleSpanProcessor(exporter) })
	return { tracer, exporter }
}

describe('OtelTracer — span tree from the forensic event stream', () => {
	it('AGENT root, LLM turn with token counts, TOOL child with error status, compaction event', () => {
		const { tracer, exporter } = memoryTracer()
		const ts = (s: number) => new Date(1700000000000 + s * 1000).toISOString()
		const ev = (e: object) => tracer.event(e as never)

		ev({ t: 'submit', text: 'build the shop', ts: ts(0) })
		ev({ t: 'model_request', turn: 0, provider: 'ollama', model: 'qwen36-agentic:latest', system: 'sys', tools: [], messages: [{ role: 'user', content: 'x' }], ts: ts(1) })
		ev({ t: 'model_response', turn: 0, text: '', thinking: '', toolUses: [{ id: 'a', name: 'Write', input: {} }], usage: { inputTokens: 4100, outputTokens: 250 }, ts: ts(9) })
		ev({ t: 'tool_call', id: 'a', name: 'Write', input: { file_path: 'src/App.tsx' }, ts: ts(9) })
		ev({ t: 'tool_result', id: 'a', name: 'Write', ok: false, ms: 12, content: 'permission denied', ts: ts(10) })
		ev({ t: 'compaction', kind: 'masked', tokensBefore: 7000, tokensAfter: 300, forced: false, ts: ts(11) })
		ev({ t: 'turn_done', turns: 1, ts: ts(12) })

		const spans = exporter.getFinishedSpans()
		const byName = (n: string) => spans.find((s) => s.name.startsWith(n))
		expect(spans.length).toBe(4) // agent + llm + tool + the compaction mark

		const root = byName('agent')!
		expect(root.attributes['openinference.span.kind']).toBe('AGENT')
		// Compaction is a SPAN now, not a root span-event: as an event it only surfaced when the root closed,
		// so during the build — the only time you care that the history just got rewritten — it was invisible.
		const compaction = byName('compaction (masked)')!
		expect(compaction.attributes['cascade.tokens_before']).toBe(7000)
		expect(compaction.attributes['cascade.tokens_after']).toBe(300)

		const llm = byName('llm turn 0')!
		expect(llm.attributes['gen_ai.usage.input_tokens']).toBe(4100)
		expect(llm.attributes['gen_ai.usage.output_tokens']).toBe(250)
		// WHO served the turn — per span, so a mid-session model switch shows up in the waterfall instead of
		// being assumed run-wide. `llm.model_name` is the key Phoenix surfaces in its UI.
		expect(llm.attributes['gen_ai.system']).toBe('ollama')
		expect(llm.attributes['gen_ai.request.model']).toBe('qwen36-agentic:latest')
		expect(llm.attributes['llm.model_name']).toBe('qwen36-agentic:latest')
		expect(llm.parentSpanContext?.spanId).toBe(root.spanContext().spanId)

		const tool = byName('tool Write')!
		expect(tool.attributes['input.value']).toContain('src/App.tsx')
		expect(tool.status.code).toBe(2) // ERROR — failed tools must be loud in the waterfall
		expect(tool.parentSpanContext?.spanId).toBe(root.spanContext().spanId)
	})

	// Phoenix Sessions (OpenInference `session.id`): each submit is its OWN trace, so a build and its
	// follow-ups arrive as unrelated traces unless they carry the chat they belong to.
	it('stamps session.id on EVERY span, so a live turn is grouped before its root has ended', () => {
		const { tracer, exporter } = memoryTracer()
		const ev = (e: object) => tracer.event(e as never)
		tracer.setSession('chat-71017fff')
		ev({ t: 'submit', text: 'build the shop' })
		ev({ t: 'model_request', turn: 0, provider: 'ollama', model: 'qwen36-agentic', system: '', tools: [], messages: [] })
		ev({ t: 'tool_call', id: 'a', name: 'Write', input: {} })
		ev({ t: 'tool_result', id: 'a', name: 'Write', ok: true, ms: 3, content: 'ok' })
		// The root is still OPEN (no turn_done) — exactly the live case. Everything exported so far must
		// already carry the session, or the turn is ungrouped for as long as it is still running.
		const live = exporter.getFinishedSpans()
		expect(live.length).toBeGreaterThan(0)
		expect(live.every((s) => s.attributes['session.id'] === 'chat-71017fff')).toBe(true)
	})

	it('a follow-up in the same chat shares the session (separate traces, one conversation)', () => {
		const { tracer, exporter } = memoryTracer()
		const ev = (e: object) => tracer.event(e as never)
		tracer.setSession('chat-abc')
		ev({ t: 'submit', text: 'build it' })
		ev({ t: 'turn_done', turns: 1 })
		ev({ t: 'submit', text: 'now add auth' }) // the follow-up: new root, new trace id
		ev({ t: 'turn_done', turns: 1 })
		const roots = exporter.getFinishedSpans().filter((s) => s.name === 'agent')
		expect(roots).toHaveLength(2)
		expect(new Set(roots.map((r) => r.spanContext().traceId)).size).toBe(2) // genuinely separate traces…
		expect(roots.every((r) => r.attributes['session.id'] === 'chat-abc')).toBe(true) // …one session
	})

	it('switching chats re-groups following turns, and clearing stops stamping', () => {
		const { tracer, exporter } = memoryTracer()
		const ev = (e: object) => tracer.event(e as never)
		tracer.setSession('chat-one')
		ev({ t: 'submit', text: 'a' })
		ev({ t: 'turn_done', turns: 1 })
		tracer.setSession('chat-two') // loadChat switched the active chat under the same session
		ev({ t: 'submit', text: 'b' })
		ev({ t: 'turn_done', turns: 1 })
		tracer.setSession(undefined)
		ev({ t: 'submit', text: 'c' })
		ev({ t: 'turn_done', turns: 1 })
		const roots = exporter.getFinishedSpans().filter((s) => s.name === 'agent')
		expect(roots.map((r) => r.attributes['session.id'])).toEqual(['chat-one', 'chat-two', undefined])
	})

	// Measured, and the reason a whole session looked empty: a dev-server restart kills the process mid-turn,
	// so the loop's `finally` never runs, `turn_done` never fires, and the AGENT root stays open. An unended
	// span is never exported — so the turn does not arrive truncated, it does not arrive at all, and the
	// viewer's per-turn view (which is built on a terminated root) has nothing to show. Six of seven turns
	// vanished this way. Shutdown must CLOSE before it flushes.
	it('endOpenSpans rescues an in-flight turn on shutdown (flushing alone would export nothing)', () => {
		const { tracer, exporter } = memoryTracer()
		const ev = (e: object) => tracer.event(e as never)
		tracer.setSession('chat-abc')
		ev({ t: 'submit', text: 'a long build' })
		ev({ t: 'model_request', turn: 0, provider: 'ollama', model: 'q', system: '', tools: [], messages: [] })
		ev({ t: 'tool_call', id: 't1', name: 'Write', input: {} })
		expect(exporter.getFinishedSpans().some((s) => s.name === 'agent')).toBe(false) // nothing to flush yet

		tracer.endOpenSpans('server shutdown') // what the shutdown handler now does BEFORE forceFlush

		const spans = exporter.getFinishedSpans()
		const root = spans.find((s) => s.name === 'agent')!
		expect(root).toBeDefined() // the turn survives the restart instead of disappearing
		expect(root.attributes['cascade.interrupted']).toBe('server shutdown')
		expect(root.status.code).toBe(2) // ERROR — a turn cut short must not read as a clean finish
		expect(spans.find((s) => s.name === 'tool Write')!.endTime).toBeTruthy() // stragglers closed too
		expect(root.attributes['session.id']).toBe('chat-abc') // still lands in the right conversation
	})

	it('a synthetic turn_done (backfill safety) closes the llm straggler and the root', () => {
		const { tracer, exporter } = memoryTracer()
		const ev = (e: object) => tracer.event(e as never)
		ev({ t: 'submit', text: 'one' })
		ev({ t: 'model_request', turn: 0, system: '', tools: [], messages: [] })
		ev({ t: 'turn_done', turns: 0 }) // the backfill script injects this synthetically
		expect(exporter.getFinishedSpans().length).toBe(2) // llm straggler + root both exported
	})

	// Measured gap: of 19 forensic event types, 6 became spans, 5 became span-EVENTS on the root (which only
	// surface once the root closes — i.e. after the build is over) and 8 hit `default: break` and reached the
	// viewer not at all. The invisible ones included slow_prefill (the only thing that EXPLAINS a
	// stalled-looking build) and post_edit_check (why the agent doubled back). Diagnostics you can't see
	// during the run are diagnostics you don't have.
	it('every diagnostic event becomes a visible span WHILE the turn is still open', () => {
		const { tracer, exporter } = memoryTracer()
		const ev = (e: object) => tracer.event(e as never)
		ev({ t: 'submit', text: 'go' })
		ev({ t: 'model_request', turn: 0, provider: 'ollama', model: 'q', contextWindow: 131072, system: '', tools: [], messages: [] })
		ev({ t: 'slow_prefill', turn: 0, waitedMs: 185_000 })
		ev({ t: 'compaction', kind: 'masked', tokensBefore: 90_000, tokensAfter: 30_000, forced: false })
		ev({ t: 'post_edit_check', turn: 0, files: 2 })
		ev({ t: 'read_loop', turn: 0, path: 'src/App.tsx' })
		ev({ t: 'todo_gate', turn: 0, open: 3 })
		ev({ t: 'stalled_verify', turn: 0 })
		ev({ t: 'degraded_retry', turn: 0 })
		ev({ t: 'plan_nudge', turn: 0 })
		ev({ t: 'delegate_nudge', turn: 0, readTokens: 40_000 })
		ev({ t: 'verify_gate', turn: 0 })
		// NOTE: the turn is deliberately still open — no turn_done. These must be exported anyway.
		const names = exporter.getFinishedSpans().map((s) => s.name)
		for (const expected of ['slow prefill (185s)', 'compaction (masked)', 'post-edit check: errors', 'nudge: read loop', 'gate: todos still open', 'nudge: stalled verify', 'degraded response — retried', 'nudge: plan first', 'nudge: delegate', 'gate: verify']) {
			expect(names, `${expected} must reach the viewer`).toContain(expected)
		}
	})

	it('a permission decision rides on the tool span it authorised (not a span of its own)', () => {
		const { tracer, exporter } = memoryTracer()
		const ev = (e: object) => tracer.event(e as never)
		ev({ t: 'submit', text: 'go' })
		ev({ t: 'permission', id: 'c1', tool: 'Write', decision: 'allow', asked: false })
		ev({ t: 'tool_call', id: 'c1', name: 'Write', input: { file_path: 'a.ts' } })
		ev({ t: 'tool_result', id: 'c1', name: 'Write', ok: true, ms: 4, content: 'ok' })
		const spans = exporter.getFinishedSpans()
		expect(spans.filter((s) => s.name.startsWith('permission'))).toHaveLength(0) // 178 of these in one build
		const tool = spans.find((s) => s.name === 'tool Write')!
		expect(tool.attributes['cascade.permission']).toBe('allow')
		expect(tool.attributes['cascade.permission_asked']).toBe(false)
	})

	it('an LLM span reports context OCCUPANCY, so throughput totals cannot be mistaken for it', () => {
		const { tracer, exporter } = memoryTracer()
		const ev = (e: object) => tracer.event(e as never)
		ev({ t: 'submit', text: 'go' })
		ev({ t: 'model_request', turn: 0, provider: 'ollama', model: 'q', contextWindow: 131072, system: '', tools: [], messages: [] })
		ev({ t: 'model_response', turn: 0, text: 'hi', thinking: '', toolUses: [], usage: { inputTokens: 44341, outputTokens: 120 } })
		const llm = exporter.getFinishedSpans().find((s) => s.name === 'llm turn 0')!
		expect(llm.attributes['cascade.context_window']).toBe(131072)
		expect(llm.attributes['cascade.context_used']).toBe(44341)
		expect(llm.attributes['cascade.context_used_pct']).toBe(34) // 34% — which is why nothing compacted
	})

	// The case the test above only LOOKED like it covered. A turn that dies with no terminator at all used to
	// strand its root span open — and an unended span is never exported, so the entire trace was lost, not
	// merely truncated. (Two of these are sitting in the user's Phoenix right now, permanently headless.)
	it('a turn that never terminates is closed by the NEXT submit, marked interrupted', () => {
		const { tracer, exporter } = memoryTracer()
		const ev = (e: object) => tracer.event(e as never)
		ev({ t: 'submit', text: 'died halfway' })
		ev({ t: 'model_request', turn: 0, provider: 'ollama', model: 'q', system: '', tools: [], messages: [] })
		ev({ t: 'tool_call', id: 'a', name: 'Write', input: {} })
		expect(exporter.getFinishedSpans().some((s) => s.name === 'agent')).toBe(false) // nothing closed it yet

		ev({ t: 'submit', text: 'next one' }) // a new turn arrives on the same (cached) tracer
		const dead = exporter.getFinishedSpans().find((s) => s.name === 'agent')!
		expect(dead).toBeDefined() // …the abandoned trace is now exported instead of lost
		expect(dead.attributes['cascade.interrupted']).toBe('interrupted')
		expect(dead.status.code).toBe(2) // ERROR — a turn that never finished must not read as success
		expect(exporter.getFinishedSpans().filter((s) => s.name.startsWith('tool ')).every((s) => s.endTime)).toBe(true)
	})
})
