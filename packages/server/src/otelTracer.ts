// otelTracer.ts — ADR-053 (amended twice): export Cascade's spans over OTLP, so any viewer (Phoenix,
// Langfuse, …) renders a build as a waterfall. Attributes carry BOTH `gen_ai.*` (Langfuse) and
// `openinference.*` (Phoenix) so either UI understands them natively.
//
// AMENDMENT 1: this started in the INSTRUMENT layer (scripts/eval), so real product builds only reached a
// viewer by replaying their .jsonl afterwards — a build you were watching live was invisible while it
// mattered. It now lives in the server package next to its consumer (projectManager.tracerFor) and stays
// INERT unless OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is set. It stayed out of `core` on purpose: core is
// bundled into the VS Code extension and shouldn't carry the OTel SDK.
//
// AMENDMENT 2 (ADR-081, 2026-08-07): this file no longer FOLDS the event stream. It is a SINK over
// core's `createSpanTracer`, which does the mapping once for every viewer. Before this, the fold lived
// here and again in the Observatory's tracer, and the two had already drifted — this file had no `case`
// for narration_loop / repeat_call / tool_cap, so the three newest loop breakers never reached Phoenix
// at all. What remains here is genuinely OTLP-specific: the OpenInference attribute vocabulary, the
// export-on-close constraint, and the session/resource plumbing.

import { trace, context, type Span, type Tracer as OtelApiTracer, SpanStatusCode } from '@opentelemetry/api'
import { BasicTracerProvider, BatchSpanProcessor, type SpanProcessor } from '@opentelemetry/sdk-trace-base'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { SemanticConventions as SC } from '@arizeai/openinference-semantic-conventions'
import { createSpanTracer, type Tracer, type TraceEvent, type TraceSpan } from '@cascade/core'

// The fold stores payloads whole; OTLP cannot carry them whole. This is a NETWORK export to a collector
// with its own limits, where an oversized span is rejected outright — losing the span entirely is worse
// than shortening one attribute. Generous, but bounded, and bounded HERE rather than at the source.
const CAP = 32_000
const cut = (s: unknown): string => String(s ?? '').slice(0, CAP)
const snake = (k: string) => k.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()

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

/** Map our flat attribute names onto the OpenInference/gen_ai vocabularies the viewers render natively.
 *  Anything without a mapping is passed through under `cascade.*`, so a new attribute shows up as data
 *  rather than vanishing. */
function toOtelAttributes(span: TraceSpan): Record<string, string | number | boolean> {
	const a = span.attributes ?? {}
	const out: Record<string, string | number | boolean> = { [SC.OPENINFERENCE_SPAN_KIND]: span.kind }
	const put = (k: string, v: unknown) => {
		if (v !== undefined && v !== null && v !== '') out[k] = v as string | number | boolean
	}

	if (a.input !== undefined) put(SC.INPUT_VALUE, cut(a.input))
	if (a.output !== undefined) put(SC.OUTPUT_VALUE, cut(a.output))

	if (span.kind === 'LLM') {
		// Emitted under BOTH vocabularies: gen_ai.* is what Langfuse reads, llm.* is what Phoenix renders.
		put('gen_ai.operation.name', 'chat')
		put('gen_ai.system', a.provider)
		put('gen_ai.request.model', a.model)
		put(SC.LLM_PROVIDER, a.provider)
		put(SC.LLM_MODEL_NAME, a.model)
		put('gen_ai.usage.input_tokens', a.inputTokens ?? 0)
		put('gen_ai.usage.output_tokens', a.outputTokens ?? 0)
		// Phoenix reads token counts from llm.token_count.* — with only the gen_ai.* pair set, its
		// cost/usage columns stayed empty even though the numbers were on the span all along.
		put(SC.LLM_TOKEN_COUNT_PROMPT, a.inputTokens ?? 0)
		put(SC.LLM_TOKEN_COUNT_COMPLETION, a.outputTokens ?? 0)
		put('llm.latency_ms', a.latencyMs)
		put('cascade.prompt_eval_ms', a.promptEvalMs)
		put('cascade.prefill_tps', a.prefillTps)
		put('cascade.decode_ms', a.decodeMs)
		put('cascade.decode_tps', a.decodeTps)
		put('cascade.model_load_ms', a.modelLoadMs)
		// OCCUPANCY, not throughput. Summing prompt tokens across calls is what a viewer shows by default
		// and it reads like a runaway (measured: 344k over 12 calls) — but each call only has to FIT, and
		// these peaked at 34% of the window, which is why nothing ever compacted.
		if (a.contextWindow) {
			put('cascade.context_window', a.contextWindow)
			put('cascade.context_used', a.inputTokens ?? 0)
			put('cascade.context_used_pct', Math.round((((a.inputTokens as number) ?? 0) / (a.contextWindow as number)) * 100))
		}
		// The assistant's reply as a STRUCTURED output message, so REASONING survives as reasoning rather
		// than being flattened away: `output.value` alone degrades to "(tools: Read,Write)" on a tool-only
		// turn, discarding the thinking that chose those tools. `reasoning` is the OpenInference-defined
		// content kind, which viewers render as its own block.
		out[`${SC.LLM_OUTPUT_MESSAGES}.0.${SC.MESSAGE_ROLE}`] = 'assistant'
		let i = 0
		const part = (type: string, value: unknown) => {
			const base = `${SC.LLM_OUTPUT_MESSAGES}.0.${SC.MESSAGE_CONTENTS}.${i++}.`
			out[base + SC.MESSAGE_CONTENT_TYPE] = type
			out[base + SC.MESSAGE_CONTENT_TEXT] = cut(value)
		}
		if (String(a.thinking ?? '').trim()) part('reasoning', a.thinking)
		if (String(a.output ?? '').trim()) part('text', a.output)
	}

	if (span.kind === 'TOOL') {
		put(SC.TOOL_NAME, a.toolName)
		put('tool.duration_ms', a.durationMs)
		put('cascade.args_repaired', a.argsRepaired)
	}

	// Everything else rides through under cascade.* — a new fold attribute becomes visible data rather
	// than being silently dropped, which is the failure mode this whole refactor exists to prevent.
	// snake_case because that IS the published OTLP vocabulary: `cascade.tokens_before` and friends are
	// what saved queries and dashboards filter on, and the fold's camelCase is an internal detail.
	const MAPPED = new Set(['input', 'output', 'provider', 'model', 'inputTokens', 'outputTokens', 'latencyMs', 'promptEvalMs', 'prefillTps', 'decodeMs', 'decodeTps', 'modelLoadMs', 'contextWindow', 'thinking', 'toolName', 'durationMs', 'argsRepaired'])
	for (const [k, v] of Object.entries(a)) {
		if (MAPPED.has(k) || v === undefined || v === null) continue
		put(k.startsWith('cascade.') ? k : `cascade.${snake(k)}`, typeof v === 'object' ? JSON.stringify(v) : v)
	}
	return out
}

/** A Cascade Tracer that exports OTel spans. Call `shutdown()` (or `forceFlush()`) before process exit. */
export class OtelTracer implements Tracer {
	private readonly provider: BasicTracerProvider
	private readonly otel: OtelApiTracer
	private readonly now: () => number
	private readonly fold: ReturnType<typeof createSpanTracer>
	private readonly rootName: string
	private session?: string
	/** The OTel span standing in for our AGENT root, so children can parent to it. */
	private root?: Span
	private rootSpanId?: string
	private rootStart = 0
	/** Spans started but not yet ended — sub-agent roots, which must exist before their children can
	 *  reference them. Keyed by the fold's span id so `parent()` can resolve an explicit parent. */
	private readonly open = new Map<string, Span>()

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
		this.fold = createSpanTracer((s) => this.onSpan(s), { rootName: this.rootName, now: this.now })
	}

	/** Group every following turn under one conversation (Phoenix's Sessions view; OpenInference `session.id`).
	 *  Each submit is its OWN trace by design — a build and its follow-ups are separate units of work — so
	 *  without this they land in the viewer as unrelated traces with nothing tying them to the chat they
	 *  belong to. Set per submit, because a session's ACTIVE CHAT can change under it (loadChat switches
	 *  chats without rebuilding the session). */
	setSession(id: string | undefined): void {
		this.session = id || undefined
		// The fold stamps `cascade.chat_id` too, so the same fact is available under both vocabularies —
		// `session.id` is what Phoenix's Sessions view reads, `cascade.chat_id` is what our own store filters.
		this.fold.setSession(id)
	}

	/** The session id goes on EACH span, not just the root: the root is the last thing to end, so during a
	 *  live turn it hasn't exported yet — a session set only there would be invisible for exactly as long
	 *  as the build is still interesting. */
	private common(): Record<string, string> {
		return this.session ? { [SC.SESSION_ID]: this.session } : {}
	}

	/**
	 * The OTLP sink. OTel can only export an ENDED span, so:
	 *  - the AGENT root's OPEN record starts a span and ends it IMMEDIATELY. That is the whole trick: a
	 *    root held open for the length of a build means nothing under it can be read until the build is
	 *    over. Ending it now ships the trace at once and each step streams in underneath as it completes.
	 *    Children legitimately outlive their parent here; the root's real wall-clock span is recorded by
	 *    the summary span below, backdated to the submit.
	 *  - every other OPEN record is IGNORED; the matching close carries the full picture.
	 */
	private onSpan(s: TraceSpan): void {
		const attrs = { ...this.common(), ...toOtelAttributes(s) }

		// Only the TURN root drives this.root. A NESTED agent (a sub-agent's root, which carries a parent)
		// must not: treating it as the turn root re-pointed this.root at the sub-agent and then cleared it
		// when the sub-agent finished, so every later span found no parent and became its own trace.
		// Measured in Phoenix: one message arrived as SIX traces. The SQLite sink was unaffected, which is
		// why only opening the other viewer caught it.
		if (s.kind === 'AGENT' && !s.parentSpanId) {
			if (s.endedAt === undefined) {
				// The fold may re-emit an OPEN record for a span it already opened (it does this to attach the
				// system prompt to the root once the first model call reveals it). A store that upserts takes
				// that in its stride; OTLP would export a SECOND root. Ignore the repeat — the attributes ride
				// along on the close record, which is where this sink acts anyway.
				if (this.rootSpanId === s.spanId) return
				this.rootSpanId = s.spanId
				this.rootStart = s.startedAt
				this.root = this.otel.startSpan(s.name, { startTime: s.startedAt, attributes: attrs })
				this.root.end(s.startedAt)
				return
			}
			// Closed: record how the turn ACTUALLY went as a summary span carrying the real start→end.
			// The root can't carry it — it was ended at submit so the trace would ship immediately.
			const reason = s.attributes?.['cascade.interrupted'] as string | undefined
			const secs = Math.max(0, Math.round((s.endedAt - this.rootStart) / 1000))
			const summary = this.otel.startSpan(
				// One prefix for every cut-short turn, whatever cut it short — so "which turns died?" is a
				// search, not an inspection of each one.
				reason ? `turn interrupted (${reason}) — ${secs}s` : `turn complete — ${secs}s`,
				{ startTime: this.rootStart, attributes: { ...attrs, [SC.OPENINFERENCE_SPAN_KIND]: 'CHAIN', 'cascade.duration_s': secs } },
				this.parent(),
			)
			if (reason) summary.setStatus({ code: SpanStatusCode.ERROR, message: `turn ${reason}` })
			summary.end(s.endedAt)
			if (s.attributes?.['cascade.error']) this.root?.setStatus({ code: SpanStatusCode.ERROR, message: cut(s.attributes['cascade.error']).slice(0, 200) })
			this.root = undefined
			this.rootSpanId = undefined
			return
		}

		if (s.endedAt === undefined) {
			// A nested AGENT (a sub-agent's root) is the one open span worth materialising early: its
			// children reference it as their parent, and OTLP has no way to attach to a span that does not
			// exist yet. Started here and ended on its close record.
			if (s.kind === 'AGENT' && s.parentSpanId) this.open.set(s.spanId, this.otel.startSpan(s.name, { startTime: s.startedAt, attributes: attrs }, this.parent(s.parentSpanId)))
			return // every other open span cannot be exported; wait for its close
		}
		const existing = this.open.get(s.spanId)
		if (existing) {
			// Re-sending the attributes on close is deliberate: the fold carries them forward, and a sub-agent
			// root written at open would otherwise never gain its turn count or interrupted reason.
			existing.setAttributes(attrs)
			if (s.status === 'error') existing.setStatus({ code: SpanStatusCode.ERROR, message: cut(s.attributes?.output).slice(0, 200) })
			existing.end(s.endedAt)
			this.open.delete(s.spanId)
			return
		}
		const span = this.otel.startSpan(s.name, { startTime: s.startedAt, attributes: attrs }, this.parent(s.parentSpanId))
		if (s.status === 'error') span.setStatus({ code: SpanStatusCode.ERROR, message: cut(s.attributes?.output).slice(0, 200) })
		span.end(s.endedAt)
	}

	/** Honour the fold's OWN parent when it names one, falling back to the turn root.
	 *  Before this, every span was parented flat under the root — which is fine while the only children
	 *  ARE the root's, and wrong the moment an agent delegates: a sub-agent's llm/tool spans would have
	 *  appeared as siblings of the sub-agent instead of inside it. */
	private parent(parentSpanId?: string) {
		const explicit = parentSpanId ? this.open.get(parentSpanId) : undefined
		const anchor = explicit ?? this.root
		return anchor ? trace.setSpan(context.active(), anchor) : undefined
	}

	event(e: TraceEvent): void {
		this.fold.event(e)
	}

	/** A sub-agent tracer that exports into THIS exporter's span tree (see SpanTracer.subAgent). */
	subAgent(name: string): Tracer {
		return this.fold.subAgent(name)
	}

	/** Open the turn before the session submits, so an orchestrated sub-agent has a root to nest under. */
	beginTurn(text: string): void {
		this.fold.beginTurn(text)
	}

	/** End anything still open because the PROCESS is going down. An unended span is not merely truncated
	 *  over OTLP — it is never exported at all. Measured: six of seven turns in one session vanished from
	 *  the viewer this way, killed by dev-server restarts. */
	endOpenSpans(reason: string): void {
		this.fold.endOpenSpans(reason)
		void this.rootSpanId // the fold drives the close; this just documents that the root is fold-owned
	}

	forceFlush(): Promise<void> {
		return this.provider.forceFlush()
	}

	shutdown(): Promise<void> {
		return this.provider.shutdown()
	}
}

/** A Tracer that can also spawn a nested sub-agent tracer (see SpanTracer.subAgent). */
export interface NestableTracer extends Tracer {
	subAgent(name: string): Tracer
	/** Open the turn root ahead of the session's own submit (see SpanTracer.beginTurn). */
	beginTurn(text: string): void
}

/**
 * Fan one event stream out to several tracers (e.g. JsonlTracer + OtelTracer + the desktop store).
 *
 * `subAgent` fans out too, and it has to: each sink keeps its OWN span-id space, so a sub-agent must be
 * nested independently in each. Sinks that don't know about nesting (JsonlTracer — a flat event log has
 * no tree to nest in) simply receive the child's events as their own.
 */
export function fanout(...tracers: Tracer[]): NestableTracer {
	return {
		event: (e) => {
			for (const t of tracers) t.event(e)
		},
		subAgent: (name) => fanout(...tracers.map((t) => ('subAgent' in t && typeof t.subAgent === 'function' ? (t as NestableTracer).subAgent(name) : t))),
		beginTurn: (text) => {
			for (const t of tracers) if ('beginTurn' in t && typeof t.beginTurn === 'function') (t as NestableTracer).beginTurn(text)
		},
	}
}
