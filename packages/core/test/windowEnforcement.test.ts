// ADR-038 ENFORCEMENT — the window on the wire. The invariant: the window the compactor protects must be
// the window the model is actually given. These tests assert the WIRE (mocked fetch): which endpoint, and
// whether options.num_ctx / num_predict / max_tokens travel.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OllamaProvider } from '../src/llm/providers/ollama'
import { OpenAIChatProvider } from '../src/llm/providers/openaiChat'
import { createSession } from '../src/session'

/** Capture fetch calls; respond with a minimal valid stream for whichever endpoint was hit. */
function mockFetch() {
	const calls: { url: string; body: Record<string, unknown> }[] = []
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string | URL, init?: RequestInit) => {
			const u = String(url)
			calls.push({ url: u, body: JSON.parse(String(init?.body ?? '{}')) })
			const payload = u.includes('/api/chat')
				? `${JSON.stringify({ message: { content: 'hi' }, done: true, done_reason: 'stop', prompt_eval_count: 1, eval_count: 1 })}\n`
				: `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\ndata: [DONE]\n\n`
			return new Response(payload, { status: 200 })
		}),
	)
	return calls
}

async function drain(iter: AsyncIterable<unknown>): Promise<void> {
	for await (const _ of iter) {
		/* consume */
	}
}

afterEach(() => vi.unstubAllGlobals())

describe('ADR-038 enforcement — the window travels on the wire', () => {
	it('ollama + contextWindow → NATIVE /api/chat with options.num_ctx + num_predict', async () => {
		const calls = mockFetch()
		const p = new OllamaProvider({ id: 'ollama', baseUrl: 'http://x' })
		await drain(p.stream({ messages: [{ role: 'user', content: 'hi' }], model: 'm', contextWindow: 32768, maxOutputTokens: 4096 }))
		expect(calls[0]!.url).toContain('/api/chat')
		expect((calls[0]!.body.options as Record<string, unknown>).num_ctx).toBe(32768)
		expect((calls[0]!.body.options as Record<string, unknown>).num_predict).toBe(4096)
	})

	it('ollama WITHOUT a confident window → NATIVE, NO num_ctx guess, but a DEFAULT num_predict backstop', async () => {
		// 2026-07-23: ollama streams ALWAYS go native (durations + whole tool-call args). The ADR-038 invariant
		// holds — an unpinned window sends no num_ctx, nothing guessed — but output is ALWAYS capped now:
		// a default num_predict prevents the unbounded thinking-runaway.
		const calls = mockFetch()
		const p = new OllamaProvider({ id: 'ollama', baseUrl: 'http://x' })
		await drain(p.stream({ messages: [{ role: 'user', content: 'hi' }], model: 'm' }))
		expect(calls[0]!.url).toContain('/api/chat')
		const opts = calls[0]!.body.options as Record<string, unknown>
		expect(opts.num_ctx).toBeUndefined() // no window pinned → no guess
		expect(opts.num_predict).toBe(16384) // but the runaway backstop is always present
	})

	it('hosted provider (groq) + contextWindow → stays /v1; only max_tokens travels', async () => {
		const calls = mockFetch()
		const p = new OpenAIChatProvider({ id: 'groq', baseUrl: 'http://x' })
		await drain(p.stream({ messages: [{ role: 'user', content: 'hi' }], model: 'm', contextWindow: 32768, maxOutputTokens: 2048 }))
		expect(calls[0]!.url).toContain('/v1/chat/completions')
		expect(calls[0]!.body.max_tokens).toBe(2048)
		expect(calls[0]!.body.num_ctx).toBeUndefined()
	})

	it('temperature rides the native options too (eval determinism preserved on the new path)', async () => {
		const calls = mockFetch()
		const p = new OllamaProvider({ id: 'ollama', baseUrl: 'http://x' })
		await drain(p.stream({ messages: [{ role: 'user', content: 'hi' }], model: 'm', contextWindow: 8192, temperature: 0 }))
		expect((calls[0]!.body.options as Record<string, unknown>).temperature).toBe(0)
	})

	// The DEFAULT path — no pinned window, so the session probes /api/show. Detection sized the compaction
	// plan but never wrote back to the "confident" limits, so nothing reached the wire: the compactor planned
	// against 131k while the request carried no num_ctx at all. That is correct ONLY while the Modelfile
	// happens to declare the same window; where it doesn't, Ollama uses its small default and front-truncates
	// the prompt in silence — precisely the failure this ADR exists to prevent.
	it('a DETECTED window reaches the wire, not just the compaction plan', async () => {
		const seen: { contextWindow?: number; maxOutputTokens?: number }[] = []
		const provider = {
			id: 'ollama',
			async complete() {
				return { text: '' }
			},
			async *stream(req: { contextWindow?: number; maxOutputTokens?: number }) {
				seen.push({ contextWindow: req.contextWindow, maxOutputTokens: req.maxOutputTokens })
				yield { type: 'done', stopReason: 'end_turn' }
			},
			async detectModelLimits() {
				return { contextWindow: 131072, maxOutputTokens: 8192 } // what /api/show reports
			},
		} as unknown as Parameters<typeof createSession>[0]['provider']

		const dir = await mkdtemp(join(tmpdir(), 'cascade-window-'))
		try {
			const session = createSession({ cwd: dir, provider, model: 'qwen36-agentic' }) // NOTE: no contextWindow pinned
			for await (const _ of session.submit('hi')) {
				/* drain */
			}
			expect(seen[0]!.contextWindow).toBe(131072) // was undefined — detection never left the compactor
			expect(seen[0]!.maxOutputTokens).toBe(8192)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})
})
