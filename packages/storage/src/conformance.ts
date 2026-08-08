// conformance.ts — the tests EVERY adapter must pass (ADR-081 §6).
//
// "You can swap the backend" stays a claim until something checks it. This is that check: one suite,
// written against the PORTS, runnable against any implementation. A Postgres adapter is finished when
// this passes — not when it compiles.
//
// It lives in the ports package, not in an adapter's own tests, precisely so it cannot quietly grow to
// match one backend's behaviour. If a case here is awkward on another engine, that is the PORT being
// wrong, and the argument then happens here rather than in an adapter that silently diverges.
//
// Exported as a function rather than as a test file so each adapter runs it under its own runner, and so
// this package keeps its "depends on nothing" property:
//
//   import { runConformance } from '@cascade/storage/conformance'
//   runConformance({ name: 'sqlite', makeTraceStore, makeConfigStore }, { describe, it, expect })

import type { ConfigStore, TraceStore } from './index.js'

/** The slice of a test runner this uses. Passed in so the ports package needs no dev dependency on a
 *  test framework — it is meant to stay importable from anywhere, including a hosted adapter's repo. */
export interface TestApi {
	describe(name: string, fn: () => void): void
	it(name: string, fn: () => Promise<void> | void): void
	expect(actual: unknown): {
		toBe(expected: unknown): void
		toEqual(expected: unknown): void
		toBeUndefined(): void
		toHaveLength(n: number): void
	}
}

export interface Adapter {
	name: string
	/** Must return a FRESH, EMPTY store on every call — these tests must not see each other's rows. */
	makeTraceStore(): Promise<TraceStore> | TraceStore
	makeConfigStore(): Promise<ConfigStore> | ConfigStore
}

export function runConformance(adapter: Adapter, t: TestApi): void {
	const { describe, it, expect } = t
	const traceStore = () => Promise.resolve(adapter.makeTraceStore())
	const configStore = () => Promise.resolve(adapter.makeConfigStore())

	describe(`${adapter.name} — TraceStore conformance`, () => {
		it('records a span and reads it back on its trace', async () => {
			const s = await traceStore()
			s.record({ traceId: 't1', spanId: 'a', name: 'agent', kind: 'AGENT', startedAt: 100, endedAt: 200, status: 'ok' })
			const spans = await s.spans('t1')
			expect(spans).toHaveLength(1)
			expect(spans[0].spanId).toBe('a')
		})

		it('record() is fire-and-forget, yet a read never lags behind it', async () => {
			// The agent loop must not await telemetry, so adapters buffer. A read therefore has to flush
			// whatever is pending — otherwise a live turn's waterfall stops short of "now", which is
			// exactly the moment someone is watching it.
			const s = await traceStore()
			s.record({ traceId: 't1', spanId: 'a', name: 'agent', kind: 'AGENT', startedAt: 1 })
			expect(await s.spans('t1')).toHaveLength(1)
		})

		it('upserts by span id — every span is emitted on open AND again on close', async () => {
			const s = await traceStore()
			s.record({ traceId: 't1', spanId: 'a', name: 'agent', kind: 'AGENT', startedAt: 1 })
			s.record({ traceId: 't1', spanId: 'a', name: 'agent', kind: 'AGENT', startedAt: 1, endedAt: 9, status: 'error' })
			const spans = await s.spans('t1')
			expect(spans).toHaveLength(1)
			expect(spans[0].endedAt).toBe(9)
			expect(spans[0].status).toBe('error')
		})

		it('summarises a trace from its ROOT span while counting every span', async () => {
			const s = await traceStore()
			s.record({ traceId: 't1', spanId: 'r', name: 'agent (builder)', kind: 'AGENT', startedAt: 500, endedAt: 3000, attributes: { 'cascade.project_id': 'p1', 'cascade.model': 'qwen', input: 'build a shop' } })
			s.record({ traceId: 't1', spanId: 'c', parentSpanId: 'r', name: 'llm turn 0', kind: 'LLM', startedAt: 600, endedAt: 900 })
			const [trace] = await s.listTraces()
			expect(trace.name).toBe('agent (builder)')
			expect(trace.prompt).toBe('build a shop')
			expect(trace.spanCount).toBe(2)
			expect(trace.durationMs).toBe(2500)
			expect(trace.projectId).toBe('p1')
			expect(trace.model).toBe('qwen')
		})

		it('reports a trace as running, with NO duration, while a span is still open', async () => {
			const s = await traceStore()
			s.record({ traceId: 't1', spanId: 'r', name: 'agent', kind: 'AGENT', startedAt: 1 })
			const [trace] = await s.listTraces()
			expect(trace.running).toBe(true)
			expect(trace.durationMs).toBeUndefined()
		})

		it('marks a trace errored if ANY span failed, independently of running', async () => {
			// A turn can be in flight AND already carrying a failed tool call. Collapsing the two hides
			// one or the other, which is why the port keeps `status` and `running` separate.
			const s = await traceStore()
			s.record({ traceId: 't1', spanId: 'r', name: 'agent', kind: 'AGENT', startedAt: 1 })
			s.record({ traceId: 't1', spanId: 'b', parentSpanId: 'r', name: 'tool Bash', kind: 'TOOL', startedAt: 2, endedAt: 3, status: 'error' })
			const [trace] = await s.listTraces()
			expect(trace.status).toBe('error')
			expect(trace.running).toBe(true)
		})

		it('filters by status, model, project and prompt text', async () => {
			const s = await traceStore()
			s.record({ traceId: 'ok', spanId: 'r1', name: 'agent', kind: 'AGENT', startedAt: 10, endedAt: 20, status: 'ok', attributes: { 'cascade.project_id': 'p1', 'cascade.model': 'qwen', input: 'add a favourites filter' } })
			s.record({ traceId: 'bad', spanId: 'r2', name: 'agent', kind: 'AGENT', startedAt: 5, endedAt: 8, status: 'error', attributes: { 'cascade.project_id': 'p2', 'cascade.model': 'gpt', input: 'build a shop' } })
			expect((await s.listTraces({ status: 'error' })).map((x) => x.traceId)).toEqual(['bad'])
			expect((await s.listTraces({ model: 'qwen' })).map((x) => x.traceId)).toEqual(['ok'])
			expect((await s.listTraces({ projectId: 'p2' })).map((x) => x.traceId)).toEqual(['bad'])
			expect((await s.listTraces({ q: 'favourites' })).map((x) => x.traceId)).toEqual(['ok'])
		})

		it('a filter narrows WHICH traces come back without corrupting their own counts', async () => {
			// The bug this pins: filtering rows before the grouping drops a trace's other spans from its
			// own aggregate, so a matched trace reports a span count and duration that are simply wrong.
			const s = await traceStore()
			s.record({ traceId: 't1', spanId: 'r', name: 'agent', kind: 'AGENT', startedAt: 100, endedAt: 900, status: 'ok', attributes: { 'cascade.model': 'qwen', input: 'build a shop' } })
			s.record({ traceId: 't1', spanId: 'c', parentSpanId: 'r', name: 'llm', kind: 'LLM', startedAt: 200, endedAt: 800 })
			const [trace] = await s.listTraces({ q: 'shop' })
			expect(trace.spanCount).toBe(2)
			expect(trace.durationMs).toBe(800)
		})

		it('pages with the keyset cursor WITHOUT dropping rows that tie on the timestamp', async () => {
			// Turns tie on the millisecond constantly (fast successive submits, replayed timestamps), and a
			// plain `started_at < cursor` silently drops every row on the boundary. Measured once as 150
			// traces paging out as 136 — a data-loss bug with no error and a green suite.
			const s = await traceStore()
			for (let i = 0; i < 6; i++) s.record({ traceId: `t${i}`, spanId: `s${i}`, name: 'agent', kind: 'AGENT', startedAt: 5000, endedAt: 5001 })
			const seen = new Set<string>()
			let cursor: { before: number; beforeId: string } | undefined
			for (let page = 0; page < 5; page++) {
				const rows = await s.listTraces({ limit: 2, ...cursor })
				if (!rows.length) break
				for (const r of rows) seen.add(r.traceId)
				const last = rows[rows.length - 1]
				cursor = { before: last.startedAt, beforeId: last.traceId }
			}
			expect([...seen].sort()).toEqual(['t0', 't1', 't2', 't3', 't4', 't5'])
		})

		it('fetches ONE span whole — the tree fetch trims payloads, this must not', async () => {
			const s = await traceStore()
			const big = 'x'.repeat(5000)
			s.record({ traceId: 't1', spanId: 'a', name: 'tool Write', kind: 'TOOL', startedAt: 1, endedAt: 2, attributes: { input: big } })
			expect(String((await s.span('a'))?.attributes?.input)).toHaveLength(5000)
			expect(await s.span('nope')).toBeUndefined()
		})

		it('searches spans ACROSS traces by kind, status and free text', async () => {
			const s = await traceStore()
			s.record({ traceId: 't1', spanId: 'a', name: 'tool Bash', kind: 'TOOL', startedAt: 1, endedAt: 2, status: 'error', attributes: { output: 'tsc: not found' } })
			s.record({ traceId: 't2', spanId: 'b', name: 'llm turn 0', kind: 'LLM', startedAt: 3, endedAt: 4, status: 'ok' })
			expect((await s.searchSpans({ status: 'error' })).map((x) => x.spanId)).toEqual(['a'])
			expect((await s.searchSpans({ kind: 'LLM' })).map((x) => x.spanId)).toEqual(['b'])
			expect((await s.searchSpans({ q: 'tsc: not found' })).map((x) => x.spanId)).toEqual(['a'])
		})

		it('groups turns into conversations, titled by the first prompt', async () => {
			const s = await traceStore()
			const chat = { 'cascade.chat_id': 'c1', 'cascade.project_id': 'p1' }
			const turn = (i: number, prompt: string, answer: string) => {
				s.record({ traceId: `t${i}`, spanId: `r${i}`, name: 'agent (builder)', kind: 'AGENT', startedAt: 1000 + i * 100, endedAt: 1050 + i * 100, attributes: { ...chat, input: prompt } })
				s.record({ traceId: `t${i}`, spanId: `l${i}`, parentSpanId: `r${i}`, name: 'llm', kind: 'LLM', startedAt: 1010 + i * 100, endedAt: 1040 + i * 100, attributes: { ...chat, output: answer, outputTokens: 100 } })
			}
			turn(0, 'build a shop', 'made the browse view')
			turn(1, 'ship it', 'build is green')
			const [session] = await s.listSessions()
			expect(session.chatId).toBe('c1')
			expect(session.turnCount).toBe(2)
			expect(session.firstPrompt).toBe('build a shop')
			expect(session.lastOutput).toBe('build is green')
			expect(session.outputTokens).toBe(200)
		})

		it('orders a conversation DETERMINISTICALLY when its turns share a millisecond', async () => {
			// First and last mean EMISSION order, not clock order. Satisfying this needs an explicit
			// monotonic column: SQLite's implicit rowid works but does not exist in Postgres or SQL
			// Server, so a port that leans on it is not actually portable. Symptom when this fails is
			// quiet and plausible — a conversation showing turn 5 of 6 as its "last output".
			const s = await traceStore()
			const chat = { 'cascade.chat_id': 'c1' }
			const labels = ['first', 'middle', 'last']
			for (let i = 0; i < labels.length; i++) {
				s.record({ traceId: `t${i}`, spanId: `r${i}`, name: 'agent', kind: 'AGENT', startedAt: 7000, endedAt: 7000, attributes: { ...chat, input: `${labels[i]} prompt` } })
				s.record({ traceId: `t${i}`, spanId: `l${i}`, parentSpanId: `r${i}`, name: 'llm', kind: 'LLM', startedAt: 7000, endedAt: 7000, attributes: { ...chat, output: `${labels[i]} answer` } })
			}
			const [session] = await s.listSessions()
			expect(session.firstPrompt).toBe('first prompt')
			expect(session.lastOutput).toBe('last answer')
		})

		it('scopes the turn list to one conversation', async () => {
			const s = await traceStore()
			s.record({ traceId: 'a', spanId: 'ra', name: 'agent', kind: 'AGENT', startedAt: 1, attributes: { 'cascade.chat_id': 'c1' } })
			s.record({ traceId: 'b', spanId: 'rb', name: 'agent', kind: 'AGENT', startedAt: 2, attributes: { 'cascade.chat_id': 'c2' } })
			expect((await s.listTraces({ chatId: 'c1' })).map((x) => x.traceId)).toEqual(['a'])
		})

		it('lists the distinct models seen', async () => {
			const s = await traceStore()
			s.record({ traceId: 't1', spanId: 'a', name: 'llm', kind: 'LLM', startedAt: 1, endedAt: 2, attributes: { 'cascade.model': 'qwen' } })
			s.record({ traceId: 't1', spanId: 'b', name: 'llm', kind: 'LLM', startedAt: 3, endedAt: 4, attributes: { 'cascade.model': 'qwen' } })
			expect(await s.models()).toEqual(['qwen'])
		})

		it('prunes old spans and keeps recent ones — retention is not optional on a desktop install', async () => {
			const s = await traceStore()
			s.record({ traceId: 't1', spanId: 'old', name: 'llm', kind: 'LLM', startedAt: 1, endedAt: 2 })
			s.record({ traceId: 't1', spanId: 'new', name: 'llm', kind: 'LLM', startedAt: Date.now() })
			expect(await s.prune(60_000)).toBe(1)
			expect((await s.spans('t1')).map((x) => x.spanId)).toEqual(['new'])
		})
	})

	describe(`${adapter.name} — ConfigStore conformance`, () => {
		it('round-trips models, the active selection and settings', async () => {
			const c = await configStore()
			await c.upsertModel({ provider: 'ollama', model: 'qwen', contextWindow: 32768 })
			await c.setActiveModel({ provider: 'ollama', model: 'qwen' })
			await c.setSetting('runtimeMode', 'host')
			expect(await c.models()).toEqual([{ provider: 'ollama', model: 'qwen', contextWindow: 32768 }])
			expect(await c.activeModel()).toEqual({ provider: 'ollama', model: 'qwen' })
			expect(await c.setting('runtimeMode')).toBe('host')
		})

		it('MERGES a model rather than replacing it', async () => {
			// The model editor sends only the fields it changed; a replace would drop the endpoint's
			// stored key and the user would have to re-enter it to change a context window.
			const c = await configStore()
			await c.upsertModel({ provider: 'x', model: 'm', baseUrl: 'https://box', apiKey: 'secret' })
			await c.upsertModel({ provider: 'x', model: 'm', contextWindow: 8192 })
			expect(await c.models()).toEqual([{ provider: 'x', model: 'm', baseUrl: 'https://box', apiKey: 'secret', contextWindow: 8192 }])
		})

		it('honours the connector key rule: omitted keeps, empty clears, a value replaces', async () => {
			const c = await configStore()
			await c.upsertConnector({ name: 'tavily', url: 'https://a', apiKey: 'k1' })
			await c.upsertConnector({ name: 'tavily', url: 'https://b' })
			expect((await c.connectors())[0]).toEqual({ name: 'tavily', url: 'https://b', apiKey: 'k1' })
			await c.upsertConnector({ name: 'tavily', apiKey: '' })
			expect((await c.connectors())[0].apiKey).toBeUndefined()
		})

		it('removes models and connectors', async () => {
			const c = await configStore()
			await c.upsertModel({ provider: 'a', model: 'm' })
			await c.upsertConnector({ name: 'c' })
			await c.removeModel('a', 'm')
			await c.removeConnector('c')
			expect(await c.models()).toEqual([])
			expect(await c.connectors()).toEqual([])
		})

		it('an unset setting reads as undefined rather than throwing', async () => {
			const c = await configStore()
			expect(await c.setting('never-set')).toBeUndefined()
		})
	})
}
