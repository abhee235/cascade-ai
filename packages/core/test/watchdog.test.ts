// WATCHDOG in core — ported from the eval runner after six live Ollama crashes + one 27-minute unanswered
// abort: mid-stream stall detection, abort-aware backoff, and the provider recycle hook.

import { describe, expect, it } from 'vitest'
import { classifyError, StallError, streamWithRecovery } from '../src/llm/resilience'
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

	it('the recycle hook fires from the 2nd consecutive transient failure on', async () => {
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
		expect(recovered).toBe(2) // not on the 1st retry (transient blips deserve one free pass), then every retry
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
