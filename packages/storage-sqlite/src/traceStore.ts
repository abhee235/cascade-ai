// traceStore.ts — SQLite-backed TraceStore (ADR-081 §5).
//
// Traces stopped being dev tooling this cycle: nearly every weak-model failure was diagnosed by
// reading one (the 114-turn thrash, the narration loop, the silent 8k window). That makes an in-app
// Observatory a product feature — and it needs a queryable store, not a JSONL file the UI has to
// parse. This is that store; the JSONL and OTLP tracers stay as-is and fan out alongside it.
//
// Queries are built with KYSELY (ADR-081, amended 2026-08-08), which buys three things the hand-written
// SQL did not have: conditional filters compose as values instead of concatenated strings, every column
// name is checked against the schema at compile time, and the dialect decides the syntax. Converting also
// forced out two leaks that would only have surfaced on Postgres — see JSON_FIELD and the HAVING note.
//
// READS are async and go through Kysely. WRITES are compiled by Kysely once and then executed
// SYNCHRONOUSLY, because `record()` is fire-and-forget on the agent's hot path and the buffered flush that
// backs it cannot await: a read immediately after a write must see the row (a conformance case).

import { sql } from 'kysely'
import type { SessionSummary, SpanRecord, TraceStore, TraceSummary } from '@cascade/storage'
import { BufferedWriter, type Db } from './db.js'
import { kyselyFor } from './kysely.js'
import type { SpansTable } from './schema.js'

/** The DB row, straight from the schema — one declaration, so a migration cannot leave the two disagreeing. */
type SpanRow = SpansTable

const str = (v: unknown): string | null => (typeof v === 'string' ? v : v == null ? null : String(v))

/**
 * Reading one field out of the JSON `attributes` column.
 *
 * THE dialect-specific expression in this file, deliberately reduced to one place. Kysely compiles
 * syntax, not vendor functions: SQLite says `json_extract(attributes, '$.input')` and Postgres says
 * `attributes::jsonb ->> 'input'`. A Postgres adapter changes this helper and nothing else.
 *
 * Kept in SQL rather than parsing in JS on purpose — the root span carries the whole system prompt, so
 * selecting entire `attributes` rows just to read one field would move megabytes per page.
 */
const jsonField = (column: 'attributes', key: string) => sql<string | null>`json_extract(${sql.ref(column)}, ${sql.lit(`$.${key}`)})`

/** Row → port shape. Shared by every read path, so a column added here surfaces everywhere at once. */
const toSpan = (r: SpanRow): SpanRecord => ({
	traceId: r.trace_id,
	spanId: r.span_id,
	parentSpanId: r.parent_id ?? undefined,
	name: r.name,
	kind: r.kind,
	startedAt: r.started_at,
	endedAt: r.ended_at ?? undefined,
	status: (r.status as 'ok' | 'error' | null) ?? undefined,
	attributes: r.attributes ? (JSON.parse(r.attributes) as Record<string, unknown>) : undefined,
})

// ── Trace-level aggregates ────────────────────────────────────────────────────────────────────────────
//
// Defined once and used in BOTH the select list and HAVING, rather than selecting an alias and filtering
// on it. SQLite lets HAVING reference an output alias; the SQL standard does not, and Postgres rejects it
// ("column has_error does not exist"). Repeating the expression is the portable form, and sharing the
// constant is what stops the two copies from drifting.
const TRACE_STARTED = sql<number>`MIN(started_at)`
const TRACE_ENDED = sql<number>`MAX(COALESCE(ended_at, started_at))`
const TRACE_HAS_ERROR = sql<number>`MAX(CASE WHEN status = 'error' THEN 1 ELSE 0 END)`
const TRACE_HAS_OPEN = sql<number>`MAX(CASE WHEN ended_at IS NULL THEN 1 ELSE 0 END)`
const TRACE_ROOT_NAME = sql<string | null>`MAX(CASE WHEN parent_id IS NULL THEN name END)`
const TRACE_MODEL = sql<string | null>`MAX(model)`
/** The root span's name plus its raw attributes — what free-text search looks through. */
const TRACE_ROOT_TEXT = sql<string | null>`MAX(CASE WHEN parent_id IS NULL THEN name || ' ' || COALESCE(attributes, '') END)`

export function createTraceStore(db: Db): TraceStore {
	const k = kyselyFor(db)

	// A span is written ONCE, when it ends — but the same span_id can arrive twice if a tracer re-emits
	// after a retry, so upsert rather than insert to keep the write idempotent.
	//
	// Compiled by Kysely (so the dialect owns the ON CONFLICT syntax) and then prepared ONCE against the
	// raw driver. Kysely's execute() is async and this runs inside a synchronous flush; compiling the
	// query is the part that benefits from a builder, and executing it is not.
	// Compiled from a template row: Kysely emits one positional placeholder per column, in this key order,
	// so the prepared statement below is bound in exactly this order. The VALUES here are never used.
	const insertSql = k
		.insertInto('spans')
		.values({ trace_id: '', span_id: '', parent_id: null, name: '', kind: '', started_at: 0, ended_at: null, status: null, project_id: null, model: null, chat_id: null, attributes: null, seq: 0 })
		.onConflict((oc) =>
			oc.column('span_id').doUpdateSet((eb) => ({
				ended_at: eb.ref('excluded.ended_at'),
				status: eb.ref('excluded.status'),
				attributes: eb.ref('excluded.attributes'),
			})),
		)
		.compile().sql
	const insert = db.prepare(insertSql)

	// Insert order, assigned by the WRITER. A span is emitted twice (open, then close) and the upsert leaves
	// `seq` alone, so a span keeps the position it first arrived at — which is what "first"/"last in this
	// conversation" actually mean. Seeded from the table so it survives a restart.
	let nextSeq = ((db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM spans').get() as { m: number }).m ?? 0) + 1

	const writer = new BufferedWriter<SpanRow>((rows) => {
		db.exec('BEGIN')
		try {
			for (const r of rows) {
				insert.run(r.trace_id, r.span_id, r.parent_id, r.name, r.kind, r.started_at, r.ended_at, r.status, r.project_id, r.model, r.chat_id, r.attributes, r.seq)
			}
			db.exec('COMMIT')
		} catch (e) {
			db.exec('ROLLBACK')
			throw e
		}
	})

	return {
		record(span: SpanRecord): void {
			const a = span.attributes ?? {}
			writer.push({
				trace_id: span.traceId,
				span_id: span.spanId,
				parent_id: span.parentSpanId ?? null,
				name: span.name,
				kind: span.kind,
				started_at: span.startedAt,
				ended_at: span.endedAt ?? null,
				status: span.status ?? null,
				project_id: str(a['cascade.project_id'] ?? a.projectId),
				model: str(a['llm.model_name'] ?? a['cascade.model'] ?? a.model),
				chat_id: str(a['cascade.chat_id'] ?? a['session.id']),
				attributes: Object.keys(a).length ? JSON.stringify(a) : null,
				seq: nextSeq++,
			})
		},

		async listTraces(opts): Promise<TraceSummary[]> {
			writer.flush() // the newest trace is usually still buffered — the list must not lag the UI

			// One row per trace: the ROOT span names it (parent_id IS NULL); the aggregate gives span count
			// and true wall span, since a root may commit before late children on some tracers.
			let q = k
				.selectFrom('spans')
				.select([
					'trace_id',
					TRACE_STARTED.as('started_at'),
					TRACE_ENDED.as('ended_at'),
					sql<number>`COUNT(*)`.as('span_count'),
					TRACE_ROOT_NAME.as('root_name'),
					sql<string | null>`MAX(CASE WHEN parent_id IS NULL THEN ${jsonField('attributes', 'input')} END)`.as('prompt'),
					TRACE_HAS_ERROR.as('has_error'),
					TRACE_HAS_OPEN.as('has_open'),
					sql<string | null>`MAX(project_id)`.as('project_id'),
					TRACE_MODEL.as('model'),
					sql<string | null>`MAX(chat_id)`.as('chat_id'),
				])
				.groupBy('trace_id')
				.orderBy('started_at', 'desc')
				.orderBy('trace_id', 'desc')
				.limit(opts?.limit ?? 50)

			// Only project/chat belong in WHERE. Everything else filters a TRACE, and a trace is an aggregate:
			// putting `started_at < before` in WHERE (as this first did) drops the late spans of an otherwise
			// included trace, so its span count and duration come back wrong. HAVING filters whole groups.
			if (opts?.projectId) q = q.where('project_id', '=', opts.projectId)
			if (opts?.chatId) q = q.where('chat_id', '=', opts.chatId)

			if (opts?.before !== undefined) {
				// Keyset cursor with a tie-breaker. `MIN(started_at) < ?` alone drops every trace that shares
				// the boundary millisecond — measured: 150 traces paged out as 136, silently. The ORDER BY
				// sorts on the same pair, so the comparison and the ordering agree and no row is skipped.
				const before = opts.before
				q = opts.beforeId
					? q.having(sql<boolean>`(${TRACE_STARTED} < ${before} OR (${TRACE_STARTED} = ${before} AND trace_id < ${opts.beforeId}))`)
					: q.having(sql<boolean>`${TRACE_STARTED} < ${before}`)
			}
			if (opts?.status === 'error') q = q.having(TRACE_HAS_ERROR, '=', 1)
			if (opts?.status === 'ok') q = q.having(TRACE_HAS_ERROR, '=', 0)
			if (opts?.model) q = q.having(TRACE_MODEL, '=', opts.model)
			if (opts?.q?.trim()) {
				// Search the ROOT span: its name is the agent label and its `input` attribute is the user's own
				// prompt — "which turn was the one where I asked about favourites?" is how you actually look.
				q = q.having(TRACE_ROOT_TEXT, 'like', `%${opts.q.trim()}%`)
			}

			const rows = await q.execute()
			return rows.map((r) => ({
				traceId: r.trace_id,
				name: r.root_name ?? '(trace)',
				prompt: r.prompt ?? undefined,
				startedAt: r.started_at,
				// A running trace has NO duration: MAX(COALESCE(ended_at, started_at)) over open spans measures
				// only the part that already closed, which reads as a fast turn when it is in fact an unfinished
				// one. Undefined is the honest answer; the UI shows it as running.
				durationMs: r.has_open ? undefined : Math.max(0, r.ended_at - r.started_at),
				spanCount: r.span_count,
				status: r.has_error ? 'error' : 'ok',
				running: !!r.has_open,
				projectId: r.project_id ?? undefined,
				model: r.model ?? undefined,
				chatId: r.chat_id ?? undefined,
			}))
		},

		async listSessions(opts): Promise<SessionSummary[]> {
			writer.flush()

			// The aggregate. errorTurns counts distinct TRACES containing a failure, not failed spans — "3 of
			// 12 turns went wrong" is the useful number; "9 failed spans" is not, since one bad turn can
			// produce several.
			let agg = k
				.selectFrom('spans')
				.select([
					'chat_id',
					sql<string | null>`MAX(project_id)`.as('project_id'),
					sql<number>`COUNT(DISTINCT trace_id)`.as('turn_count'),
					sql<number>`COUNT(DISTINCT CASE WHEN status = 'error' THEN trace_id END)`.as('error_turns'),
					TRACE_STARTED.as('started_at'),
					TRACE_ENDED.as('ended_at'),
					TRACE_HAS_OPEN.as('has_open'),
				])
				.where('chat_id', 'is not', null)
				.groupBy('chat_id')
				.orderBy(TRACE_ENDED, 'desc')
				.limit(opts?.limit ?? 50)
			if (opts?.projectId) agg = agg.where('project_id', '=', opts.projectId)

			const rows = await agg.execute()
			if (!rows.length) return []
			const ids = rows.map((r) => r.chat_id as string)

			// First prompt and last output, two rows per session rather than every root span, via window
			// functions. Fetching all roots and reducing in JS would pull one row per TURN — fine at 20 turns,
			// wasteful at 500, and this list is the landing page.
			//
			// seq breaks ties, and ties are the common case: turns inside one conversation can share a
			// millisecond, and started_at alone then lets the engine pick arbitrarily — which showed turn 5 of
			// 6 as a conversation's "last output". seq is insertion order, i.e. emission order, which is
			// exactly the sequence we mean by first and last. It is an explicit column, NOT SQLite's rowid, so
			// this survives a move to Postgres.
			const ranked = k
				.selectFrom('spans')
				.select([
					'chat_id',
					'kind',
					'attributes',
					sql<number>`ROW_NUMBER() OVER (PARTITION BY chat_id, kind ORDER BY started_at ASC,  seq ASC)`.as('rn_first'),
					sql<number>`ROW_NUMBER() OVER (PARTITION BY chat_id, kind ORDER BY started_at DESC, seq DESC)`.as('rn_last'),
				])
				.where('chat_id', 'in', ids)
				.where('kind', 'in', ['AGENT', 'LLM'])
				.where('attributes', 'is not', null)
				.as('ranked')

			const edges = await k
				.selectFrom(ranked)
				.select(['chat_id', 'kind', 'attributes', 'rn_first', 'rn_last'])
				.where((eb) => eb.or([eb('rn_first', '=', 1), eb('rn_last', '=', 1)]))
				.execute()

			const first = new Map<string, string>()
			const last = new Map<string, string>()
			for (const e of edges) {
				const a = JSON.parse(e.attributes ?? '{}') as Record<string, unknown>
				// The opening PROMPT is the earliest AGENT root's input; the closing answer is the latest LLM
				// span's output (the root carries no output — it is a container).
				if (e.kind === 'AGENT' && e.rn_first === 1 && typeof a.input === 'string') first.set(e.chat_id as string, a.input)
				if (e.kind === 'LLM' && e.rn_last === 1 && typeof a.output === 'string') last.set(e.chat_id as string, a.output)
			}

			// Models + output tokens per session. Separate because both need to scan LLM spans, and folding
			// them into the aggregate above would force that scan for sessions we then discard by LIMIT.
			const stats = await k
				.selectFrom('spans')
				.select(['chat_id', 'model', sql<number>`COUNT(*)`.as('n'), sql<number>`SUM(COALESCE(${jsonField('attributes', 'outputTokens')}, 0))`.as('out_tokens')])
				.where('chat_id', 'in', ids)
				.where('kind', '=', 'LLM')
				.groupBy(['chat_id', 'model'])
				.orderBy('n', 'desc')
				.execute()

			const models = new Map<string, string[]>()
			const tokens = new Map<string, number>()
			for (const s of stats) {
				const id = s.chat_id as string
				if (s.model) models.set(id, [...(models.get(id) ?? []), s.model])
				tokens.set(id, (tokens.get(id) ?? 0) + Number(s.out_tokens ?? 0))
			}

			return rows.map((r) => {
				const id = r.chat_id as string
				return {
					chatId: id,
					projectId: r.project_id ?? undefined,
					firstPrompt: first.get(id),
					lastOutput: last.get(id),
					turnCount: r.turn_count,
					startedAt: r.started_at,
					endedAt: r.ended_at,
					errorTurns: r.error_turns,
					outputTokens: tokens.get(id) ?? 0,
					models: models.get(id) ?? [],
					running: !!r.has_open,
				}
			})
		},

		async spans(traceId: string): Promise<SpanRecord[]> {
			writer.flush() // a LIVE trace is mid-write; without this the waterfall stops short of "now"
			const rows = await k.selectFrom('spans').selectAll().where('trace_id', '=', traceId).orderBy('started_at', 'asc').execute()
			return rows.map(toSpan)
		},

		async span(spanId: string): Promise<SpanRecord | undefined> {
			writer.flush()
			const row = await k.selectFrom('spans').selectAll().where('span_id', '=', spanId).executeTakeFirst()
			return row ? toSpan(row) : undefined
		},

		async searchSpans(opts): Promise<SpanRecord[]> {
			writer.flush()
			let q = k.selectFrom('spans').selectAll().orderBy('started_at', 'desc').limit(opts?.limit ?? 200)
			if (opts?.projectId) q = q.where('project_id', '=', opts.projectId)
			if (opts?.kind) q = q.where('kind', '=', opts.kind)
			if (opts?.status) q = q.where('status', '=', opts.status)
			if (opts?.q?.trim()) {
				// Name OR attributes: the name finds "tool Bash", the attributes find the file path in its input
				// or the error text in its output. One box, because a user hunting a failure does not yet know
				// which of those their memory of it lives in.
				const needle = `%${opts.q.trim()}%`
				q = q.where((eb) => eb.or([eb('name', 'like', needle), eb(sql<string>`COALESCE(attributes, '')`, 'like', needle)]))
			}
			return (await q.execute()).map(toSpan)
		},

		async models(): Promise<string[]> {
			writer.flush()
			// Ordered by most-recently-used, so the filter's first option is the model you are working with.
			const rows = await k
				.selectFrom('spans')
				.select(['model', sql<number>`MAX(started_at)`.as('last')])
				.where('model', 'is not', null)
				.groupBy('model')
				.orderBy('last', 'desc')
				.execute()
			return rows.map((r) => r.model as string)
		},

		async prune(olderThanMs: number): Promise<number> {
			// A desktop install runs for months; without retention the DB grows without bound.
			// Flush FIRST: buffered spans are not in the table yet, so a delete before this leaves the newest
			// batch unpruned and reports 0 (caught by test).
			writer.flush()
			const cutoff = Date.now() - olderThanMs
			// SYNCHRONOUS, like the insert and for the same reason. Retention is kicked off fire-and-forget at
			// open (`void traces.prune(...)`), so an awaited delete lands on a later microtask — and a caller
			// that reads straight afterwards sees the rows still there. Caught by a test the moment this moved
			// to Kysely; Kysely still builds the statement, it just does not execute it.
			const { sql: text, parameters } = k.deleteFrom('spans').where('started_at', '<', cutoff).compile()
			return Number(db.prepare(text).run(...(parameters as never[])).changes ?? 0)
		},

		async flush(): Promise<void> {
			writer.flush()
		},
	}
}
