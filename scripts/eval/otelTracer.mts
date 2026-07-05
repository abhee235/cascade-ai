// scripts/eval/otelTracer.mts — ADR-053: map Cascade's forensic event stream onto OpenTelemetry spans, so
// any OTLP viewer (Phoenix, Langfuse, …) renders the whole flow as a waterfall. Lives in the INSTRUMENT
// layer (not core): runners wire it when an endpoint is configured; product traces reach the viewer via
// otelBackfill.mts. Attributes carry BOTH `gen_ai.*` (Langfuse) and `openinference.*` (Phoenix) so either
// UI understands the spans natively.
//
// Span tree per submit:  AGENT (submit … turn_done)
//                          ├─ LLM  turn N (model_request … model_response; token counts, text previews)
//                          ├─ TOOL <name>  (tool_call … tool_result; input, result preview, error flag)
//                          └─ events: compaction / delegate_nudge / verify_gate / hook / error

import { trace, context, type Span, type Tracer as OtelApiTracer, SpanStatusCode } from '@opentelemetry/api'
import { BasicTracerProvider, BatchSpanProcessor, type SpanProcessor } from '@opentelemetry/sdk-trace-base'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { resourceFromAttributes } from '@opentelemetry/resources'
import type { Tracer, TraceEvent } from '@cascade/core'

const CAP = 4_000 // attribute payload cap — viewers truncate anyway; keep exports light
const cut = (s: unknown): string => String(s ?? '').slice(0, CAP)

export interface OtelTracerOptions {
	/** OTLP HTTP endpoint, e.g. Phoenix: http://localhost:6006/v1/traces. */
	endpoint: string
	/** service.name shown in the viewer; use the run label / project name. */
	service: string
	/** Extra resource attributes (model, scenario, …). */
	attributes?: Record<string, string>
	/** Injected timestamps (backfill replays original event times). Omit ⇒ wall clock. */
	now?: () => number
	/** Test seam: inject a span processor (e.g. SimpleSpanProcessor(InMemoryExporter)) instead of OTLP. */
	processor?: SpanProcessor
}

/** A Cascade Tracer that exports OTel spans. Call `shutdown()` (or `forceFlush()`) before process exit. */
export class OtelTracer implements Tracer {
	private readonly provider: BasicTracerProvider
	private readonly otel: OtelApiTracer
	private readonly now: () => number
	private root?: Span
	private llm?: Span
	private llmStart = 0
	private readonly tools = new Map<string, { span: Span }>()

	constructor(opts: OtelTracerOptions) {
		const processor: SpanProcessor = opts.processor ?? new BatchSpanProcessor(new OTLPTraceExporter({ url: opts.endpoint }))
		this.provider = new BasicTracerProvider({
			resource: resourceFromAttributes({ 'service.name': opts.service, ...opts.attributes }),
			spanProcessors: [processor],
		})
		this.otel = this.provider.getTracer('cascade')
		this.now = opts.now ?? (() => Date.now())
	}

	event(e: TraceEvent & { ts?: string }): void {
		const at = e.ts ? Date.parse(e.ts) : this.now()
		switch (e.t) {
			case 'submit': {
				this.root = this.otel.startSpan('agent', { startTime: at, attributes: { 'openinference.span.kind': 'AGENT', 'input.value': cut(e.text) } })
				break
			}
			case 'model_request': {
				const parent = this.root ? trace.setSpan(context.active(), this.root) : undefined
				this.llmStart = at
				this.llm = this.otel.startSpan(`llm turn ${e.turn}`, { startTime: at, attributes: { 'openinference.span.kind': 'LLM', 'gen_ai.operation.name': 'chat', 'input.value': cut(JSON.stringify(e.messages.slice(-2))) } }, parent)
				break
			}
			case 'model_response': {
				const span = this.llm
				if (!span) break
				span.setAttributes({
					'gen_ai.usage.input_tokens': e.usage?.inputTokens ?? 0,
					'gen_ai.usage.output_tokens': e.usage?.outputTokens ?? 0,
					'output.value': cut(e.text || `(tools: ${e.toolUses.map((t) => t.name).join(',') || 'none'})`),
					'llm.latency_ms': at - this.llmStart,
				})
				span.end(at)
				this.llm = undefined
				break
			}
			case 'tool_call': {
				const parent = this.root ? trace.setSpan(context.active(), this.root) : undefined
				const span = this.otel.startSpan(`tool ${e.name}`, { startTime: at, attributes: { 'openinference.span.kind': 'TOOL', 'tool.name': e.name, 'input.value': cut(JSON.stringify(e.input)), ...(e.repaired ? { 'cascade.args_repaired': true } : {}) } }, parent)
				this.tools.set(e.id, { span })
				break
			}
			case 'tool_result': {
				const t = this.tools.get(e.id)
				if (!t) break
				t.span.setAttributes({ 'output.value': cut(e.content), 'tool.duration_ms': e.ms })
				if (!e.ok) t.span.setStatus({ code: SpanStatusCode.ERROR, message: cut(e.content).slice(0, 200) })
				t.span.end(at)
				this.tools.delete(e.id)
				break
			}
			case 'compaction':
				this.root?.addEvent('compaction', { kind: e.kind, tokensBefore: e.tokensBefore, tokensAfter: e.tokensAfter, forced: e.forced }, at)
				break
			case 'delegate_nudge':
				this.root?.addEvent('delegate_nudge', { readTokens: e.readTokens }, at)
				break
			case 'verify_gate':
				this.root?.addEvent('verify_gate', { turn: e.turn }, at)
				break
			case 'hook':
				this.root?.addEvent('hook', { event: e.event, tool: e.tool, decision: e.decision, ms: e.ms }, at)
				break
			case 'error':
				this.root?.addEvent('error', { message: cut(e.message) }, at)
				this.root?.setStatus({ code: SpanStatusCode.ERROR, message: cut(e.message).slice(0, 200) })
				break
			case 'turn_done': {
				// Close any straggler spans first (aborts/timeouts leave them open), then the root.
				for (const [, t] of this.tools) t.span.end(at)
				this.tools.clear()
				this.llm?.end(at)
				this.llm = undefined
				this.root?.setAttribute('cascade.model_turns', e.turns)
				this.root?.end(at)
				this.root = undefined
				break
			}
			default:
				break
		}
	}

	forceFlush(): Promise<void> {
		return this.provider.forceFlush()
	}

	shutdown(): Promise<void> {
		return this.provider.shutdown()
	}
}

/** Fan one event stream out to several tracers (e.g. JsonlTracer + OtelTracer). */
export function fanout(...tracers: Tracer[]): Tracer {
	return { event: (e) => { for (const t of tracers) t.event(e) } }
}
