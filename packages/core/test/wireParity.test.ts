// WIRE PARITY (ADR-077 postmortem) — for every session-level parameter, assert exactly what each adapter
// puts on the wire, INCLUDING the ones it cannot carry.
//
// Why this exists: the custom-endpoint feature (ADR-076) was verified at the TRANSPORT level only (URL, key,
// streaming) — "same provider, just a different baseUrl". It isn't: each wire protocol carries a different
// subset of the session's parameters, and every gap shipped as a silent production failure, found one trace
// at a time (2026-07-24/25, rented Vast.ai box):
//   • maxOutputTokens unset → /v1 sent NO cap → the backend's own default truncated turns at 38 tokens.
//   • contextWindow 131000 → /v1 has NO field for it → remote Ollama ran at 32k and squeezed generation to
//     zero (in+out == 32768 on every turn) while the compactor planned against 131k.
//   • prefill/decode timings → /v1 usage has no durations → every speed observable read 0.
// This file is the parity matrix as executable assertions. If you add a request param or an adapter, extend
// the matrix HERE — an unlisted param is exactly how the next silent gap ships.
//
// ┌─────────────────┬──────────────────┬─────────────────────┬───────────────────────┐
// │ session param   │ ollama native    │ OpenAI-compat /v1   │ OpenAI Responses      │
// ├─────────────────┼──────────────────┼─────────────────────┼───────────────────────┤
// │ system          │ messages[0]      │ messages[0]         │ instructions          │
// │ tools           │ tools            │ tools               │ tools (flattened)     │
// │ temperature     │ options.temp…    │ temperature         │ — (reasoning rejects) │
// │ topP            │ options.top_p    │ top_p               │ —                     │
// │ topK            │ options.top_k    │ — (no wire field)   │ —                     │
// │ contextWindow   │ options.num_ctx  │ — (no wire field!)  │ — (hosted, fixed)     │
// │ maxOutputTokens │ options.num_pre… │ max_tokens          │ max_output_tokens     │
// │   …when UNSET   │ 16384 backstop   │ 16384 backstop      │ 16384 backstop        │
// └─────────────────┴──────────────────┴─────────────────────┴───────────────────────┘
// (Response side, not asserted here: only the native path returns prompt_eval/eval durations — the reason
//  api:'ollama' exists at all. /v1 usage is token counts only.)

import { afterEach, describe, expect, it, vi } from 'vitest'
import { OllamaProvider } from '../src/llm/providers/ollama'
import { DEFAULT_MAX_OUTPUT_TOKENS, OpenAIChatProvider } from '../src/llm/providers/openaiChat'
import { OpenAIResponsesProvider } from '../src/llm/providers/openaiResponses'
import type { CompletionRequest } from '../src/llm/provider'

/** One request with EVERY session-settable field present — the full surface under test. */
const FULL: CompletionRequest = {
	messages: [{ role: 'user', content: 'hi' }],
	model: 'm',
	system: 'be terse',
	tools: [{ name: 'Read', description: 'read a file', inputSchema: { type: 'object', properties: {} } }],
	temperature: 0.3,
	topP: 0.9,
	topK: 40,
	repeatPenalty: 1.1,
	presencePenalty: 1.5,
	contextWindow: 131000,
	maxOutputTokens: 2048,
}
/** And the bare minimum — what a custom endpoint gets when the user configures nothing. */
const MINIMAL: CompletionRequest = { messages: [{ role: 'user', content: 'hi' }], model: 'm' }

/** Stub fetch with a benign end-of-stream body, drain the adapter's stream(), return the sent body. */
async function sent(provider: { stream: (r: CompletionRequest, s?: AbortSignal) => AsyncIterable<unknown> }, req: CompletionRequest, fixture: string): Promise<{ url: string; body: any }> {
	const fetchMock = vi.fn(async () => new Response(fixture, { status: 200 }))
	vi.stubGlobal('fetch', fetchMock)
	for await (const _ of provider.stream(req)) {
		/* drain */
	}
	const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
	return { url: String(url), body: JSON.parse(String(init.body)) }
}

const NATIVE_EOS = '{"done":true,"done_reason":"stop","message":{"role":"assistant","content":"ok"}}\n'
const SSE_EOS = 'data: [DONE]\n\n'

afterEach(() => vi.unstubAllGlobals())

describe('wire parity — ollama native /api/chat', () => {
	it('carries EVERY session param (the reference adapter)', async () => {
		const { url, body } = await sent(new OllamaProvider({ id: 'vast', baseUrl: 'http://x' }), FULL, NATIVE_EOS)
		expect(url).toBe('http://x/api/chat')
		expect(body.options.num_ctx).toBe(131000) // ADR-038: the window is ENFORCED on this path — the reason api:'ollama' exists
		expect(body.options.num_predict).toBe(2048)
		expect(body.options.temperature).toBe(0.3)
		expect(body.options.top_p).toBe(0.9)
		expect(body.options.top_k).toBe(40)
		expect(body.options.repeat_penalty).toBe(1.1)
		expect(body.options.presence_penalty).toBe(1.5)
		expect(body.tools?.length).toBe(1)
		expect(body.messages[0]).toMatchObject({ role: 'system', content: 'be terse' })
	})
	it('unset cap → the 16384 backstop, never omitted', async () => {
		const { body } = await sent(new OllamaProvider({ id: 'vast', baseUrl: 'http://x' }), MINIMAL, NATIVE_EOS)
		expect(body.options.num_predict).toBe(DEFAULT_MAX_OUTPUT_TOKENS)
	})
})

describe('wire parity — OpenAI-compatible /v1/chat/completions', () => {
	it('SELF-HOSTED endpoint (custom id): sampling, penalties AND the extensions flow; contextWindow stays wire-impossible', async () => {
		// The 'vast' id is not a builtin hosted gateway, so this is the ADR-076 path — vLLM, SGLang,
		// llama.cpp server, LM Studio — where top_k and repetition_penalty are honored on the compat route.
		const { url, body } = await sent(new OpenAIChatProvider({ id: 'vast', baseUrl: 'http://x' }), FULL, SSE_EOS)
		expect(url).toBe('http://x/v1/chat/completions')
		expect(body.temperature).toBe(0.3)
		expect(body.top_p).toBe(0.9)
		expect(body.top_k).toBe(40)
		expect(body.repetition_penalty).toBe(1.1)
		expect(body.presence_penalty).toBe(1.5)
		expect(body.max_tokens).toBe(2048)
		expect(body.tools?.length).toBe(1)
		expect(body.messages[0]).toMatchObject({ role: 'system', content: 'be terse' })
		// Still wire-impossible everywhere on this route — the 32k-squeeze failure class:
		expect(JSON.stringify(body)).not.toMatch(/num_ctx|context_window|contextWindow/)
	})

	it('HOSTED gateway (openai id): the extensions are withheld — they 400 there; presence_penalty is standard and flows', async () => {
		const { body } = await sent(new OpenAIChatProvider({ id: 'openai' }), FULL, SSE_EOS)
		expect(body.top_k).toBeUndefined()
		expect(body.repetition_penalty).toBeUndefined()
		expect(body.presence_penalty).toBe(1.5)
		expect(body.max_completion_tokens).toBe(2048) // current OpenAI models reject max_tokens
	})
	it('unset cap → the 16384 backstop, never omitted (the 38-token-truncation regression)', async () => {
		const { body } = await sent(new OpenAIChatProvider({ id: 'vast', baseUrl: 'http://x' }), MINIMAL, SSE_EOS)
		expect(body.max_tokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS)
	})
})

describe('wire parity — OpenAI Responses', () => {
	it('system → instructions, cap → max_output_tokens; sampling deliberately absent (reasoning models reject it)', async () => {
		const { url, body } = await sent(new OpenAIResponsesProvider({ id: 'openai', baseUrl: 'http://x' }), FULL, SSE_EOS)
		expect(url).toBe('http://x/v1/responses')
		expect(body.instructions).toBe('be terse')
		expect(body.max_output_tokens).toBe(2048)
		expect(body.tools?.length).toBe(1)
		expect(body.temperature).toBeUndefined()
		expect(body.top_p).toBeUndefined()
		expect(JSON.stringify(body)).not.toMatch(/num_ctx|context_window/)
	})
	it('unset cap → the 16384 backstop, never omitted (same bug class existed here — fixed with this test)', async () => {
		const { body } = await sent(new OpenAIResponsesProvider({ id: 'openai', baseUrl: 'http://x' }), MINIMAL, SSE_EOS)
		expect(body.max_output_tokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS)
	})
})

describe('output-cap clamping — strict servers reject input+cap > window', () => {
	// Measured on vLLM: a 24,577-token prompt + the fixed 16,384 cap totalled one token over a 40,960
	// window → HTTP 400 on every retry, in the gap where the prompt is too big for the cap but too small
	// to trigger compaction. The clamp shrinks the ASK, never the prompt.
	const big = 'x'.repeat(33_000) // ≈10k tokens by the deliberately-conservative 3.3 chars/token estimate

	it('shrinks max_tokens to the room the window has left', async () => {
		const { body } = await sent(new OpenAIChatProvider({ id: 'vast', baseUrl: 'http://x' }), { messages: [{ role: 'user', content: big }], model: 'm', contextWindow: 12_000, maxOutputTokens: 16_384 }, SSE_EOS)
		expect(body.max_tokens).toBeGreaterThanOrEqual(1024)
		expect(body.max_tokens).toBeLessThan(2_000) // ~12000 − ~10800 estimated input
	})

	it('floors at 1024 when even that barely fits — a 50-token budget helps nobody', async () => {
		const { body } = await sent(new OpenAIChatProvider({ id: 'vast', baseUrl: 'http://x' }), { messages: [{ role: 'user', content: big }], model: 'm', contextWindow: 10_000, maxOutputTokens: 16_384 }, SSE_EOS)
		expect(body.max_tokens).toBe(1024)
	})

	it('leaves the cap alone when the window has plenty of room', async () => {
		const { body } = await sent(new OpenAIChatProvider({ id: 'vast', baseUrl: 'http://x' }), { messages: [{ role: 'user', content: 'hi' }], model: 'm', contextWindow: 131_000, maxOutputTokens: 2_048 }, SSE_EOS)
		expect(body.max_tokens).toBe(2_048)
	})
})

describe('strict-server 400 self-heal — retry once with the server’s own numbers', () => {
	const VLLM_400 = JSON.stringify({ error: { message: "This model's maximum context length is 40960 tokens. However, you requested 16384 output tokens and your prompt contains at least 24577 input tokens, for a total of at least 40961 tokens." } })

	it('parses the exact input count from the 400 and retries with the cap that fits', async () => {
		// Estimation can only approximate the tokenizer (the 3.3-chars/token version missed by ~1,400 tokens
		// on dense code and let the 400 through). The server's rejection carries the EXACT numbers — use them.
		let call = 0
		const fetchMock = vi.fn(async () => (++call === 1 ? new Response(VLLM_400, { status: 400 }) : new Response(SSE_EOS, { status: 200 })))
		vi.stubGlobal('fetch', fetchMock)
		const provider = new OpenAIChatProvider({ id: 'vllm', baseUrl: 'http://x' })
		for await (const _ of provider.stream({ messages: [{ role: 'user', content: 'hi' }], model: 'm', maxOutputTokens: 16_384 })) {
			/* drain */
		}
		expect(fetchMock).toHaveBeenCalledTimes(2)
		const retryBody = JSON.parse(String((fetchMock.mock.calls[1] as any)[1].body))
		expect(retryBody.max_tokens).toBe(40_960 - 24_577 - 64) // the server said what fits; ask for exactly that
	})

	it('a 400 that is NOT the length rejection still throws immediately — no blind retries', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"message":"invalid role"}}', { status: 400 })))
		const provider = new OpenAIChatProvider({ id: 'vllm', baseUrl: 'http://x' })
		await expect(async () => {
			for await (const _ of provider.stream({ messages: [{ role: 'user', content: 'hi' }], model: 'm' })) {
				/* drain */
			}
		}).rejects.toThrow(/400/)
	})
})
