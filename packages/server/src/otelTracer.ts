// otelTracer.ts — ADR-053 (amended): map Cascade's forensic event stream onto OpenTelemetry spans, so any
// OTLP viewer (Phoenix, Langfuse, …) renders the whole flow as a waterfall. Attributes carry BOTH `gen_ai.*`
// (Langfuse) and `openinference.*` (Phoenix) so either UI understands the spans natively.
//
// AMENDMENT: this started in the INSTRUMENT layer (scripts/eval), which meant real product builds only
// reached a viewer by replaying their .jsonl afterwards with otelBackfill.mts — so a build you were watching
// live was invisible while it mattered. It now lives in the server package, next to its product consumer
// (projectManager.tracerFor), and stays INERT unless OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is set. It stayed out
// of `core` on purpose: core is bundled into the VS Code extension and shouldn't carry the OTel SDK.
// scripts/eval/otelTracer.mts re-exports from here, so the eval runners and backfill are unchanged.
//
// Span tree per submit:  AGENT (submit … turn_done)
//                          ├─ LLM  turn N (model_request … model_response; token counts, text previews)
//                          ├─ TOOL <name>  (tool_call … tool_result; input, result preview, error flag)
//                          └─ events: compaction / delegate_nudge / verify_gate / hook / error

import { trace, context, type Span, type Tracer as OtelApiTracer, SpanStatusCode } from '@opentelemetry/api'
import { BasicTracerProvider, BatchSpanProcessor, type SpanProcessor } from '@opentelemetry/sdk-trace-base'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { SemanticConventions as SC } from '@arizeai/openinference-semantic-conventions'
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
	/** Which viewer-side project these traces belong to (Phoenix groups by it). Omit ⇒ the viewer's default,
	 *  where product builds and eval runs pile into one bucket. */
	project?: string
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
	private session?: string
	private window?: number // the context window this turn's prompts are sized against (from model_request)
	/** permission decisions keyed by tool-call id — they arrive BEFORE the tool span exists, so they wait here. */
	private readonly pendingPermission = new Map<string, Record<string, string | boolean>>()

	constructor(opts: OtelTracerOptions) {
		const processor: SpanProcessor = opts.processor ?? new BatchSpanProcessor(new OTLPTraceExporter({ url: opts.endpoint }))
		this.provider = new BasicTracerProvider({
			resource: resourceFromAttributes({
				'service.name': opts.service,
				...(opts.project ? { 'openinference.project.name': opts.project } : {}),
				...opts.attributes,
			}),
			spanProcessors: [processor],
		})
		this.otel = this.provider.getTracer('cascade')
		this.now = opts.now ?? (() => Date.now())
	}

	/** Group every following turn under one conversation (Phoenix's Sessions view; OpenInference `session.id`).
	 *  Each submit is its OWN trace by design — a build and its follow-ups are separate units of work — so
	 *  without this they land in the viewer as unrelated traces with nothing tying them to the chat they
	 *  belong to. Set per submit, because a session's ACTIVE CHAT can change under it (loadChat switches
	 *  chats without rebuilding the session). */
	setSession(id: string | undefined): void {
		this.session = id || undefined
	}

	/** Attributes every span carries. The session id goes on EACH span, not just the root: the root is the
	 *  last thing to end (it spans the whole build), so during a live turn it hasn't been exported yet — a
	 *  session set only there would be invisible for exactly as long as the build is still interesting. */
	private common(): Record<string, string> {
		return this.session ? { [SC.SESSION_ID]: this.session } : {}
	}

	/** A notable MOMENT (a nudge fired, a compaction ran, a prefill stalled) as a zero-length span, hung off
	 *  whatever is currently innermost. These used to be `root.addEvent(...)` — which only surfaces when the
	 *  ROOT closes, i.e. at the very end of the build, i.e. never while you are actually watching it. As a
	 *  span it exports on the next batch (~5s) and lands in the waterfall at the instant it happened. */
	private mark(name: string, at: number, attrs: Record<string, string | number | boolean> = {}): void {
		const anchor = this.llm ?? this.root
		const parent = anchor ? trace.setSpan(context.active(), anchor) : undefined
		const span = this.otel.startSpan(name, { startTime: at, attributes: { ...this.common(), [SC.OPENINFERENCE_SPAN_KIND]: 'CHAIN', ...attrs } }, parent)
		span.end(at)
	}

	/** End every span still open, innermost first. An unended span is NEVER exported — so leaving one open
	 *  doesn't truncate a trace, it deletes it. `reason` marks turns that ended without a terminator. */
	private closeOpenSpans(at: number, reason?: string): void {
		for (const [, t] of this.tools) {
			if (reason) t.span.setAttribute('cascade.interrupted', reason)
			t.span.end(at)
		}
		this.tools.clear()
		if (this.llm && reason) this.llm.setAttribute('cascade.interrupted', reason)
		this.llm?.end(at)
		this.llm = undefined
		if (this.root && reason) {
			this.root.setAttribute('cascade.interrupted', reason)
			this.root.setStatus({ code: SpanStatusCode.ERROR, message: `turn ${reason}` })
		}
		this.root?.end(at)
		this.root = undefined
	}

	event(e: TraceEvent & { ts?: string }): void {
		const at = e.ts ? Date.parse(e.ts) : this.now()
		switch (e.t) {
			case 'submit': {
				// Belt-and-braces: if the previous turn never terminated (a crash between its last event and
				// `turn_done`), overwriting `this.root` would strand it OPEN forever — and an unended span is
				// never exported, so that whole trace would be lost rather than merely truncated. Close it.
				this.closeOpenSpans(at, 'interrupted')
				// One AGENT span wrapping the whole run, per the OpenInference convention ("a span that
				// encompasses calls to LLMs and Tools"). It ends at turn_done — which is also when the turn
				// becomes visible, because a viewer's per-turn view is built on a TERMINATED root span. An
				// earlier attempt to make in-flight turns findable (a zero-length marker child) backfired: the
				// viewer promoted the orphan to a phantom 0ms root, so the trace list gained an entry that
				// opened onto nothing. Live activity is still visible span-by-span in the Spans view; the
				// turn itself appears once it ends — and `endOpenSpans` guarantees it always does.
				this.root = this.otel.startSpan('agent', { startTime: at, attributes: { ...this.common(), [SC.OPENINFERENCE_SPAN_KIND]: 'AGENT', [SC.INPUT_VALUE]: cut(e.text) } })
				break
			}
			case 'model_request': {
				const parent = this.root ? trace.setSpan(context.active(), this.root) : undefined
				this.llmStart = at
				this.window = e.contextWindow
				this.llm = this.otel.startSpan(
					`llm turn ${e.turn}`,
					{
						startTime: at,
						attributes: {
							...this.common(),
							[SC.OPENINFERENCE_SPAN_KIND]: 'LLM',
							'gen_ai.operation.name': 'chat',
							// WHO answered — a mid-session model switch is then visible span-by-span instead of
							// assumed run-wide. Emitted under BOTH vocabularies: gen_ai.* is what Langfuse reads,
							// llm.* is what Phoenix renders natively.
							'gen_ai.system': e.provider,
							'gen_ai.request.model': e.model,
							[SC.LLM_PROVIDER]: e.provider,
							[SC.LLM_MODEL_NAME]: e.model,
							[SC.INPUT_VALUE]: cut(JSON.stringify(e.messages.slice(-2))),
						},
					},
					parent,
				)
				break
			}
			case 'model_response': {
				const span = this.llm
				if (!span) break
				span.setAttributes({
					'gen_ai.usage.input_tokens': e.usage?.inputTokens ?? 0,
					'gen_ai.usage.output_tokens': e.usage?.outputTokens ?? 0,
					// Phoenix reads token counts from llm.token_count.* — with only the gen_ai.* pair set, its
					// cost/usage columns stayed empty even though the numbers were on the span all along.
					[SC.LLM_TOKEN_COUNT_PROMPT]: e.usage?.inputTokens ?? 0,
					[SC.LLM_TOKEN_COUNT_COMPLETION]: e.usage?.outputTokens ?? 0,
					[SC.OUTPUT_VALUE]: cut(e.text || `(tools: ${e.toolUses.map((t) => t.name).join(',') || 'none'})`),
					'llm.latency_ms': at - this.llmStart,
					// OCCUPANCY, not throughput. Summing prompt tokens across calls is what a viewer shows by
					// default and it reads like a runaway (measured: 344k over 12 calls) — but each call only has
					// to FIT, and these peaked at 34% of the window, which is why nothing ever compacted.
					...(this.window
						? {
								'cascade.context_window': this.window,
								'cascade.context_used': e.usage?.inputTokens ?? 0,
								'cascade.context_used_pct': Math.round(((e.usage?.inputTokens ?? 0) / this.window) * 100),
							}
						: {}),
				})
				span.end(at)
				this.llm = undefined
				break
			}
			case 'tool_call': {
				const parent = this.root ? trace.setSpan(context.active(), this.root) : undefined
				const span = this.otel.startSpan(
					`tool ${e.name}`,
					{
						startTime: at,
						attributes: {
							...this.common(),
							[SC.OPENINFERENCE_SPAN_KIND]: 'TOOL',
							[SC.TOOL_NAME]: e.name,
							[SC.INPUT_VALUE]: cut(JSON.stringify(e.input)),
							...(this.pendingPermission.get(e.id) ?? {}), // who authorised this call, and was the user asked
							...(e.repaired ? { 'cascade.args_repaired': true } : {}),
						},
					},
					parent,
				)
				this.pendingPermission.delete(e.id)
				this.tools.set(e.id, { span })
				break
			}
			case 'tool_result': {
				const t = this.tools.get(e.id)
				if (!t) break
				t.span.setAttributes({ [SC.OUTPUT_VALUE]: cut(e.content), 'tool.duration_ms': e.ms })
				if (!e.ok) t.span.setStatus({ code: SpanStatusCode.ERROR, message: cut(e.content).slice(0, 200) })
				t.span.end(at)
				this.tools.delete(e.id)
				break
			}
			// ── Notable moments ──────────────────────────────────────────────────────────────────────────
			// Every one of these used to be either a span-EVENT on the root (surfacing only once the root
			// closed, i.e. after the build was over) or dropped on the floor by the `default` below. Eight
			// types reached the viewer not at all — including slow_prefill, which is the single event that
			// EXPLAINS a stalled-looking build, and post_edit_check, which explains why the agent doubled back.
			case 'compaction':
				this.mark(`compaction (${e.kind})`, at, { 'cascade.tokens_before': e.tokensBefore, 'cascade.tokens_after': e.tokensAfter, 'cascade.forced': e.forced })
				break
			case 'delegate_nudge':
				this.mark('nudge: delegate', at, { 'cascade.read_tokens': e.readTokens, 'cascade.turn': e.turn })
				break
			case 'verify_gate':
				this.mark('gate: verify', at, { 'cascade.turn': e.turn })
				break
			case 'plan_nudge':
				this.mark('nudge: plan first', at, { 'cascade.turn': e.turn })
				break
			case 'todo_gate':
				this.mark('gate: todos still open', at, { 'cascade.turn': e.turn, 'cascade.open': e.open })
				break
			case 'read_loop':
				this.mark('nudge: read loop', at, { 'cascade.turn': e.turn, 'cascade.path': e.path })
				break
			case 'stalled_verify':
				this.mark('nudge: stalled verify', at, { 'cascade.turn': e.turn })
				break
			case 'post_edit_check':
				this.mark('post-edit check: errors', at, { 'cascade.turn': e.turn, 'cascade.files': e.files })
				break
			case 'degraded_retry':
				this.mark('degraded response — retried', at, { 'cascade.turn': e.turn })
				break
			case 'slow_prefill':
				// The dead-air explainer: the backend is alive and chewing through a big cold prompt.
				this.mark(`slow prefill (${Math.round(e.waitedMs / 1000)}s)`, at, { 'cascade.turn': e.turn, 'cascade.waited_ms': e.waitedMs })
				break
			case 'hook':
				this.mark(`hook ${e.event} → ${e.decision}`, at, { 'cascade.tool': e.tool, 'cascade.duration_ms': e.ms })
				break
			case 'permission':
				// 1:1 with the tool call that follows, so it rides on THAT span instead of adding a span per
				// call (measured: 178 in one build — enough to bury the actual work in the waterfall).
				this.pendingPermission.set(e.id, { 'cascade.permission': e.decision, 'cascade.permission_asked': e.asked })
				break
			case 'error':
				this.mark('error', at, { 'cascade.message': cut(e.message) })
				this.root?.setStatus({ code: SpanStatusCode.ERROR, message: cut(e.message).slice(0, 200) })
				break
			case 'turn_done': {
				this.root?.setAttribute('cascade.model_turns', e.turns)
				this.closeOpenSpans(at) // stragglers first (an aborted turn leaves tool/llm spans open), then the root
				break
			}
			default:
				break
		}
	}

	/** End anything still open because the PROCESS is going down. A hard exit never runs the loop's `finally`,
	 *  so `turn_done` never fires — and an unended span is not merely truncated, it is never exported at all.
	 *  Measured: six of seven turns in one session vanished from the viewer this way, killed by dev-server
	 *  restarts. Closing them here turns "gone" into "interrupted", which is a fact you can actually see. */
	endOpenSpans(reason: string): void {
		this.closeOpenSpans(this.now(), reason)
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
