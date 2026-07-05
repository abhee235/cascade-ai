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
		ev({ t: 'model_request', turn: 0, system: 'sys', tools: [], messages: [{ role: 'user', content: 'x' }], ts: ts(1) })
		ev({ t: 'model_response', turn: 0, text: '', thinking: '', toolUses: [{ id: 'a', name: 'Write', input: {} }], usage: { inputTokens: 4100, outputTokens: 250 }, ts: ts(9) })
		ev({ t: 'tool_call', id: 'a', name: 'Write', input: { file_path: 'src/App.tsx' }, ts: ts(9) })
		ev({ t: 'tool_result', id: 'a', name: 'Write', ok: false, ms: 12, content: 'permission denied', ts: ts(10) })
		ev({ t: 'compaction', kind: 'masked', tokensBefore: 7000, tokensAfter: 300, forced: false, ts: ts(11) })
		ev({ t: 'turn_done', turns: 1, ts: ts(12) })

		const spans = exporter.getFinishedSpans()
		const byName = (n: string) => spans.find((s) => s.name.startsWith(n))
		expect(spans.length).toBe(3)

		const root = byName('agent')!
		expect(root.attributes['openinference.span.kind']).toBe('AGENT')
		expect(root.events.some((e) => e.name === 'compaction' && e.attributes?.kind === 'masked')).toBe(true)

		const llm = byName('llm turn 0')!
		expect(llm.attributes['gen_ai.usage.input_tokens']).toBe(4100)
		expect(llm.attributes['gen_ai.usage.output_tokens']).toBe(250)
		expect(llm.parentSpanContext?.spanId).toBe(root.spanContext().spanId)

		const tool = byName('tool Write')!
		expect(tool.attributes['input.value']).toContain('src/App.tsx')
		expect(tool.status.code).toBe(2) // ERROR — failed tools must be loud in the waterfall
		expect(tool.parentSpanContext?.spanId).toBe(root.spanContext().spanId)
	})

	it('an aborted run (no turn_done) still closes open spans on the next submit (backfill safety)', () => {
		const { tracer, exporter } = memoryTracer()
		const ev = (e: object) => tracer.event(e as never)
		ev({ t: 'submit', text: 'one' })
		ev({ t: 'model_request', turn: 0, system: '', tools: [], messages: [] })
		ev({ t: 'turn_done', turns: 0 }) // the backfill script injects this synthetically
		expect(exporter.getFinishedSpans().length).toBe(2) // llm straggler + root both exported
	})
})
