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
	/** Which agent this tracer serves ("builder" | "planner"), used to NAME the root. One user prompt on a
	 *  fresh project produces two turns — the plan stage runs to completion first, then the builder — and with
	 *  both roots called "agent" the only way to tell them apart was to open one and notice AskUserQuestion. */
	kind?: string
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
	private readonly rootName: string // "agent (planner)" / "agent (builder)" — one prompt yields both
	private turnStart = 0 // wall clock of the submit — the summary span is backdated to it
	private turns = 0 // model turns so far, reported on the summary
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
		this.rootName = opts.kind ? `agent (${opts.kind})` : 'agent'
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

	/** The assistant's reply as a STRUCTURED output message, so REASONING survives as reasoning rather than
	 *  being flattened away. `output.value` alone cannot carry it: on a tool-only turn it degrades to
	 *  "(tools: Read,Write)" and the thinking that chose those tools is discarded — precisely the turn you
	 *  need to understand when a local model goes somewhere strange. `message_content.type` of "reasoning" is
	 *  the OpenInference-defined kind, which viewers render as its own block. */
	private outputMessage(thinking: string, text: string): Record<string, string> {
		const attrs: Record<string, string> = { [`${SC.LLM_OUTPUT_MESSAGES}.0.${SC.MESSAGE_ROLE}`]: 'assistant' }
		let i = 0
		const part = (type: string, value: string) => {
			const base = `${SC.LLM_OUTPUT_MESSAGES}.0.${SC.MESSAGE_CONTENTS}.${i++}.`
			attrs[base + SC.MESSAGE_CONTENT_TYPE] = type
			attrs[base + SC.MESSAGE_CONTENT_TEXT] = cut(value)
		}
		if (thinking.trim()) part('reasoning', thinking)
		if (text.trim()) part('text', text)
		return attrs
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

	/** Close out a turn: end the step spans still open, then record how the turn ACTUALLY went as a summary
	 *  span carrying the real start→end times. The root can't carry that itself — it was ended at submit so
	 *  the trace would ship immediately — so duration lives here instead, backdated to the submit. */
	private closeTurn(at: number, reason?: string): void {
		for (const [, t] of this.tools) {
			if (reason) t.span.setAttribute('cascade.interrupted', reason)
			t.span.end(at)
		}
		this.tools.clear()
		if (this.llm && reason) this.llm.setAttribute('cascade.interrupted', reason)
		this.llm?.end(at)
		this.llm = undefined
		if (!this.root) return
		const secs = Math.max(0, Math.round((at - this.turnStart) / 1000))
		const summary = this.otel.startSpan(
			// One prefix for every cut-short turn, whatever cut it short — so "which turns died?" is a search,
			// not an inspection of each one.
			reason ? `turn interrupted (${reason}) — ${secs}s` : `turn complete — ${secs}s`,
			{ startTime: this.turnStart, attributes: { ...this.common(), [SC.OPENINFERENCE_SPAN_KIND]: 'CHAIN', 'cascade.duration_s': secs, ...(this.turns ? { 'cascade.model_turns': this.turns } : {}) } },
			trace.setSpan(context.active(), this.root),
		)
		if (reason) summary.setStatus({ code: SpanStatusCode.ERROR, message: `turn ${reason}` })
		summary.end(at)
		this.root = undefined
		this.turns = 0
	}

	event(e: TraceEvent & { ts?: string }): void {
		const at = e.ts ? Date.parse(e.ts) : this.now()
		switch (e.t) {
			case 'submit': {
				// Belt-and-braces: if the previous turn never terminated (a crash between its last event and
				// `turn_done`), overwriting `this.root` would strand it OPEN forever — and an unended span is
				// never exported, so that whole trace would be lost rather than merely truncated. Close it.
				this.closeTurn(at, 'interrupted') // a previous turn that never terminated
				this.turnStart = at
				// The AGENT root, per the OpenInference convention — but ENDED IMMEDIATELY, which is the whole
				// trick. A span ships only when it ends, so a root held open for the length of the build means
				// nothing under it can be read until the build is over: every step sits referencing a parent the
				// viewer has never seen. Ending it now ships the trace at once, and each step then streams in
				// underneath as it completes — the point of the exercise is watching a build while it runs.
				// Children legitimately outlive their parent here; the true wall-clock span of the turn is
				// recorded by the summary span in closeTurn(), backdated to this instant.
				this.root = this.otel.startSpan(this.rootName, { startTime: at, attributes: { ...this.common(), [SC.OPENINFERENCE_SPAN_KIND]: 'AGENT', [SC.INPUT_VALUE]: cut(e.text) } })
				this.root.end(at)
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
					...this.outputMessage(e.thinking ?? '', e.text ?? ''),
					'gen_ai.usage.input_tokens': e.usage?.inputTokens ?? 0,
					'gen_ai.usage.output_tokens': e.usage?.outputTokens ?? 0,
					// Phoenix reads token counts from llm.token_count.* — with only the gen_ai.* pair set, its
					// cost/usage columns stayed empty even though the numbers were on the span all along.
					[SC.LLM_TOKEN_COUNT_PROMPT]: e.usage?.inputTokens ?? 0,
					[SC.LLM_TOKEN_COUNT_COMPLETION]: e.usage?.outputTokens ?? 0,
					[SC.OUTPUT_VALUE]: cut(e.text || `(tools: ${e.toolUses.map((t) => t.name).join(',') || 'none'})`),
					'llm.latency_ms': at - this.llmStart,
					// Prefill/decode split (Ollama native durations; ADR-053 amendment 2026-07-23). This is the
					// KV-cache observable: prompt token COUNTS include cached tokens, so a cache miss shows up
					// ONLY here — prefill_tps collapses (~500 tok/s = full re-prefill) vs a hit (10k+ tok/s).
					// A nonzero load_ms mid-session means the runner itself was evicted and reloaded.
					...(e.usage?.promptEvalMs
						? {
								'cascade.prompt_eval_ms': e.usage.promptEvalMs,
								'cascade.prefill_tps': Math.round(((e.usage.inputTokens ?? 0) / e.usage.promptEvalMs) * 1000),
							}
						: {}),
					...(e.usage?.decodeMs
						? {
								'cascade.decode_ms': e.usage.decodeMs,
								'cascade.decode_tps': Math.round((((e.usage.outputTokens ?? 0) / e.usage.decodeMs) * 1000 + Number.EPSILON) * 10) / 10,
							}
						: {}),
					...(e.usage?.loadMs && e.usage.loadMs > 500 ? { 'cascade.model_load_ms': e.usage.loadMs } : {}),
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
				this.turns = e.turns
				this.closeTurn(at) // stragglers, then the summary span carrying the real duration
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
		this.closeTurn(this.now(), reason)
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
