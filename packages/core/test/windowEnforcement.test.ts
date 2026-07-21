// ADR-038 ENFORCEMENT — the window on the wire. The invariant: the window the compactor protects must be
// the window the model is actually given. These tests assert the WIRE (mocked fetch): which endpoint, and
// whether options.num_ctx / num_predict / max_tokens travel.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { OllamaProvider } from '../src/llm/providers/ollama'
import { OpenAIChatProvider } from '../src/llm/providers/openaiChat'

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

	it('ollama WITHOUT a confident window → /v1 unchanged (no guessed enforcement)', async () => {
		const calls = mockFetch()
		const p = new OllamaProvider({ id: 'ollama', baseUrl: 'http://x' })
		await drain(p.stream({ messages: [{ role: 'user', content: 'hi' }], model: 'm' }))
		expect(calls[0]!.url).toContain('/v1/chat/completions')
		expect(calls[0]!.body.options).toBeUndefined()
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
})
