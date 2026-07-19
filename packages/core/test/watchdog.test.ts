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
