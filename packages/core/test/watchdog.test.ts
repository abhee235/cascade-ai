// WATCHDOG in core — ported from the eval runner after six live Ollama crashes + one 27-minute unanswered
// abort: mid-stream stall detection, abort-aware backoff, and the provider recycle hook.

import { describe, expect, it } from 'vitest'
import { classifyError, completeWithRecovery, StallError, streamWithRecovery } from '../src/llm/resilience'
import type { StreamEvent } from '../src/llm/provider'

const done = (): StreamEvent => ({ type: 'done', stopReason: 'end_turn' })
const text = (t: string): StreamEvent => ({ type: 'text_delta', text: t })

async function collect(iter: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
	const out: StreamEvent[] = []
	for await (const ev of iter) out.push(ev)
	return out
}

describe('watchdog — stall detection', () => {
	it('a silent stream is declared stalled, retried, and succeeds on the fresh attempt', async () => {
		let attempt = 0
		const make = (): AsyncIterable<StreamEvent> => ({
			async *[Symbol.asyncIterator]() {
				attempt++
				if (attempt === 1) {
					yield text('partial…')
					await new Promise(() => {}) // hangs forever — open connection, silent stream
				}
				yield text('recovered')
				yield done()
			},
		})
		const events = await collect(streamWithRecovery(make, { stallTimeoutMs: 50, sleep: async () => {}, baseDelayMs: 1 }))
		expect(attempt).toBe(2)
		expect(events.some((e) => e.type === 'retry')).toBe(true)
		expect(events.some((e) => e.type === 'text_delta' && e.text === 'recovered')).toBe(true)
	})

	it('StallError classifies as transient (so it retries, never fatals)', () => {
		expect(classifyError(new StallError(180_000))).toBe('transient')
	})

	it('the recycle hook fires at the 2nd consecutive transient, and success RESETS the budget', async () => {
		let attempt = 0
		let recovered = 0
		const make = (): AsyncIterable<StreamEvent> => ({
			async *[Symbol.asyncIterator]() {
				attempt++
				if (attempt <= 3) throw Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' })
				yield done()
			},
		})
		await collect(streamWithRecovery(make, { sleep: async () => {}, baseDelayMs: 1, recover: async () => void recovered++ }))
		expect(attempt).toBe(4)
		// 1st failure: free pass. 2nd: recover fires, succeeds → budget resets. 3rd failure is attempt 1 of
		// the FRESH budget (no recover), then success. One recycle, not one per retry.
		expect(recovered).toBe(1)
	})

	it('a successful recover() lets the stream outlive the base retry budget (crash + slow reload)', async () => {
		// 7 consecutive failures would exhaust maxRetries=5 outright — but each successful recover() grants a
		// fresh budget (the measured iterate-2 failure: rounds died in ~15s of retries while the crashed 15GB
		// model needed minutes to reload; recover()'s reload-probe IS the wait).
		let attempt = 0
		let recovered = 0
		const make = (): AsyncIterable<StreamEvent> => ({
			async *[Symbol.asyncIterator]() {
				attempt++
				if (attempt <= 7) throw Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' })
				yield text('back alive')
				yield done()
			},
		})
		const events = await collect(streamWithRecovery(make, { sleep: async () => {}, baseDelayMs: 1, recover: async () => void recovered++ }))
		expect(events.some((e) => e.type === 'text_delta' && e.text === 'back alive')).toBe(true)
		expect(recovered).toBeGreaterThanOrEqual(3) // multiple resets bridged the outage
	})

	it('recover() resets are CAPPED — a deterministically-crashing backend still fails honestly', async () => {
		let recovered = 0
		const make = (): AsyncIterable<StreamEvent> => ({
			async *[Symbol.asyncIterator]() {
				throw Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' }) // fails forever
			},
		})
		await expect(collect(streamWithRecovery(make, { sleep: async () => {}, baseDelayMs: 1, recover: async () => void recovered++ }))).rejects.toThrow()
		expect(recovered).toBe(3) // default maxRecoveries — then the remaining budget runs out and we fail
	})

	it('completeWithRecovery guards NON-streaming calls the same way (the unguarded-summarize lesson)', async () => {
		// iterate-5: a 300s backend wedge on the compactor's raw complete() killed whole rounds. The twin
		// wrapper retries transients, recycles at ≥2, and a verified recycle refreshes the budget.
		let call = 0
		let recovered = 0
		const result = await completeWithRecovery(
			async () => {
				call++
				if (call <= 7) throw Object.assign(new Error('fetch failed (Headers Timeout Error)'), { code: 'UND_ERR_HEADERS_TIMEOUT' })
				return 'summary text'
			},
			{ sleep: async () => {}, baseDelayMs: 1, recover: async () => void recovered++ },
		)
		expect(result).toBe('summary text')
		expect(recovered).toBeGreaterThanOrEqual(3) // resets bridged what a plain budget could not
	})

	it('completeWithRecovery: a BODY-HANG trips the per-attempt deadline and recovers (iterate-7 live)', async () => {
		// Measured: headers arrived, then the body never did — a non-streaming complete() has no inter-byte
		// timeout, so the await hung 40+ min with every guard unfireable. The deadline converts the hang
		// into a StallError → transient → retry; the next attempt succeeds.
		let call = 0
		const result = await completeWithRecovery(
			() => {
				call++
				if (call === 1) return new Promise<never>(() => {}) // hangs forever — the wedge
				return Promise.resolve('summary')
			},
			{ stallTimeoutMs: 50, sleep: async () => {}, baseDelayMs: 1 },
		)
		expect(result).toBe('summary')
		expect(call).toBe(2) // the hung attempt was abandoned, not awaited to death
	})

	it('completeWithRecovery fails fast on fatal errors (no retry burn)', async () => {
		let call = 0
		await expect(
			completeWithRecovery(
				async () => {
					call++
					throw Object.assign(new Error('unauthorized'), { status: 401 })
				},
				{ sleep: async () => {} },
			),
		).rejects.toThrow()
		expect(call).toBe(1)
	})

	it('an EMPTY terminal response triggers one recycle-and-retry through the real loop (iterate-7)', async () => {
		// A crashed-then-reloaded backend returns SUCCESSFUL but EMPTY responses — no error, so recovery
		// never fires and the session silently ends with nothing. The loop now recycles once and re-asks.
		const { runAgentLoop } = await import('../src/agent/agentLoop')
		let call = 0
		let recycled = 0
		const provider = {
			id: 'fake',
			recover: async () => void recycled++,
			async complete() {
				return { text: '' }
			},
			async *stream(): AsyncIterable<StreamEvent> {
				call++
				if (call === 1) {
					yield { type: 'done', stopReason: 'end_turn' } // ENTIRELY empty response
					return
				}
				yield text('real answer after recycle')
				yield { type: 'done', stopReason: 'end_turn' }
			},
		}
		const events: string[] = []
		for await (const ev of runAgentLoop([{ role: 'user', content: 'plan this' }], { provider: provider as never, model: 'fake', cwd: process.cwd(), signal: new AbortController().signal, verifyGate: false })) {
			if (ev.type === 'message') events.push(JSON.stringify(ev.message.content))
		}
		expect(call).toBe(2) // re-asked after the recycle
		expect(recycled).toBe(1)
		expect(events.join(' ')).toContain('real answer after recycle')
	})

	it('a SECOND empty terminal is accepted (no infinite recycle loop)', async () => {
		const { runAgentLoop } = await import('../src/agent/agentLoop')
		let call = 0
		let recycled = 0
		const provider = {
			id: 'fake',
			recover: async () => void recycled++,
			async complete() {
				return { text: '' }
			},
			async *stream(): AsyncIterable<StreamEvent> {
				call++
				yield { type: 'done', stopReason: 'end_turn' } // empty forever
			},
		}
		let done = false
		for await (const ev of runAgentLoop([{ role: 'user', content: 'x' }], { provider: provider as never, model: 'fake', cwd: process.cwd(), signal: new AbortController().signal, verifyGate: false })) {
			if (ev.type === 'turnDone') done = true
		}
		expect(done).toBe(true) // terminated honestly
		expect(call).toBe(2) // exactly one retry
		expect(recycled).toBe(1) // exactly one recycle
	})

	it('TODO GATE: a terminal answer with open todos is refused once, then work continues (Simmer)', async () => {
		// Measured: "Let me fix that and move on to Create AddForm" — intention, then silence, with open
		// todos. The gate injects the open items once; a second terminal is accepted (no infinite loop).
		const { runAgentLoop } = await import('../src/agent/agentLoop')
		const { TodoStore } = await import('../src/tools/todoStore')
		const todoStore = new TodoStore()
		todoStore.set(0, [
			{ content: 'Create AddForm', status: 'pending', activeForm: 'Creating AddForm' },
			{ content: 'Wire views', status: 'in_progress', activeForm: 'Wiring views' },
		])
		let call = 0
		const provider = {
			id: 'fake',
			async complete() {
				return { text: '' }
			},
			async *stream(req: { messages: unknown[] }): AsyncIterable<StreamEvent> {
				call++
				if (call === 1) {
					yield text('Let me fix that and move on to Create AddForm.') // intention → stop
					yield { type: 'done', stopReason: 'end_turn' }
					return
				}
				// The gate's reminder must be in the request now.
				const hasNudge = JSON.stringify(req.messages).includes('unfinished item')
				yield text(hasNudge ? 'CONTINUED AND FINISHED' : 'no nudge seen')
				yield { type: 'done', stopReason: 'end_turn' }
			},
		}
		const texts: string[] = []
		for await (const ev of runAgentLoop([{ role: 'user', content: 'build it' }], { provider: provider as never, model: 'fake', cwd: process.cwd(), signal: new AbortController().signal, todoStore })) {
			if (ev.type === 'message') texts.push(JSON.stringify(ev.message.content))
		}
		expect(call).toBe(2) // refused once, continued, then the second terminal was accepted (todos still open)
		expect(texts.join(' ')).toContain('CONTINUED AND FINISHED')
	})

	it('TODO GATE re-arms after successful work, and names a failed call (Simmer 128k submit-2)', async () => {
		// Measured: the once-per-submit budget was spent on a turn-0 conversational stop; 7 turns later —
		// after a build run, a read, and a garbled failed Edit — the model went terminal THINKING-ONLY
		// ("Let me fix data.ts…" then silence) and the spent gate let the session end. Successful tool work
		// since the last firing must RE-ARM the gate; a stop right after a failed call must NAME that call.
		const { runAgentLoop } = await import('../src/agent/agentLoop')
		const { TodoStore } = await import('../src/tools/todoStore')
		const todoStore = new TodoStore()
		const items = [
			{ content: 'Fix data.ts', status: 'in_progress' as const, activeForm: 'Fixing data.ts' },
			{ content: 'Wire App.tsx', status: 'pending' as const, activeForm: 'Wiring App.tsx' },
		]
		todoStore.set(0, items)
		const think = (thinking: string) => ({ type: 'thinking_delta' as const, thinking })
		let call = 0
		const provider = {
			id: 'fake',
			async complete() {
				return { text: '' }
			},
			async *stream(): AsyncIterable<StreamEvent> {
				call++
				if (call === 1) {
					// Work happens (TodoWrite succeeds) but the Edit FAILS (bad target) — then next turn stops.
					yield { type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos: items } }
					yield { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: 'nope-does-not-exist.ts', old_string: 'a', new_string: 'b' } }
					yield { type: 'done', stopReason: 'tool_use' }
					return
				}
				if (call === 2 || call === 4) {
					// THINKING-ONLY terminal — an intention, zero visible text, zero tools. Not an answer.
					yield think('Let me fix data.ts and then build the remaining views.')
					yield { type: 'done', stopReason: 'end_turn' }
					return
				}
				if (call === 3) {
					yield { type: 'tool_use', id: 't3', name: 'TodoWrite', input: { todos: items } } // real work again → re-arms
					yield { type: 'done', stopReason: 'tool_use' }
					return
				}
				yield text('DONE NOW')
				yield { type: 'done', stopReason: 'end_turn' }
			},
		}
		const messages = [{ role: 'user' as const, content: 'finish the build' }]
		for await (const _ of runAgentLoop(messages, { provider: provider as never, model: 'fake', cwd: process.cwd(), signal: new AbortController().signal, todoStore })) {
			/* drain */
		}
		const history = JSON.stringify(messages)
		expect(history.split('You stopped mid-task').length - 1).toBe(2) // fired at call 2 AND re-armed for call 4
		expect(history).toContain('your last tool call FAILED — Edit:') // the failed Edit is named, retry is concrete
		expect(call).toBe(5) // …and the model got to finish for real
	})

	it('TODO GATE: a FAILED attempt also re-arms — compliance with corrupted args is not stonewalling', async () => {
		// Measured (Simmer 128k submit 3): gate fired → the model complied with a TodoWrite whose args were
		// corrupted (activeForm missing → call FAILED) → silent again — and success-only re-arming accepted
		// that as the end, one nudge short of recovery. Any attempt re-arms; the firings cap bounds it.
		const { runAgentLoop } = await import('../src/agent/agentLoop')
		const { TodoStore } = await import('../src/tools/todoStore')
		const todoStore = new TodoStore()
		todoStore.set(0, [{ content: 'Fix data.ts', status: 'in_progress', activeForm: 'Fixing data.ts' }])
		const think = (thinking: string) => ({ type: 'thinking_delta' as const, thinking })
		let call = 0
		const provider = {
			id: 'fake',
			async complete() {
				return { text: '' }
			},
			async *stream(): AsyncIterable<StreamEvent> {
				call++
				if (call === 1 || call === 3) {
					yield think('One more go. I will fix data.ts completely.') // intention, then silence
					yield { type: 'done', stopReason: 'end_turn' }
					return
				}
				if (call === 2) {
					// Compliance attempt with CORRUPTED args (the measured garbled-Edit shape — args missing
					// entirely). Note: a TodoWrite missing only activeForm no longer fails (tolerant schema),
					// so the still-invalid Edit is the right corruption to replay here.
					yield { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'src/data.ts' } }
					yield { type: 'done', stopReason: 'tool_use' }
					return
				}
				yield text('RECOVERED AND DONE')
				yield { type: 'done', stopReason: 'end_turn' }
			},
		}
		const messages = [{ role: 'user' as const, content: 'finish it' }]
		for await (const _ of runAgentLoop(messages, { provider: provider as never, model: 'fake', cwd: process.cwd(), signal: new AbortController().signal, todoStore })) {
			/* drain */
		}
		const history = JSON.stringify(messages)
		expect(history.split('You stopped mid-task').length - 1).toBe(2) // re-armed by the FAILED attempt
		expect(history).toContain('your last tool call FAILED — Edit:') // and the broken call is named
		expect(call).toBe(4)
	})

	it('abort during backoff resolves promptly instead of waiting out the delay', async () => {
		const ctl = new AbortController()
		let attempt = 0
		const make = (): AsyncIterable<StreamEvent> => ({
			async *[Symbol.asyncIterator]() {
				attempt++
				if (attempt === 1) throw Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' })
				const err = new Error('aborted')
				err.name = 'AbortError'
				throw err
			},
		})
		const t0 = Date.now()
		setTimeout(() => ctl.abort(), 20) // abort lands mid-backoff
		await expect(collect(streamWithRecovery(make, { signal: ctl.signal, baseDelayMs: 60_000, maxDelayMs: 60_000 }))).rejects.toThrow()
		expect(Date.now() - t0).toBeLessThan(5_000) // did NOT wait out the 60s backoff
	})
})
