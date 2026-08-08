// Native vLLM support — a KNOWN provider id, not a hand-typed URL (the "just like ollama" ask).
//
// What "native" buys over the ADR-076 custom-endpoint path it builds on:
//   · it appears in the provider menu, pre-configured, with the `vllm serve` default origin
//   · the Model Manager lists what the server is actually serving (GET /v1/models), so the exact model id
//     cannot be mistyped — the #1 custom-endpoint config error
//   · the SERVED context window is probed from vLLM's max_model_len instead of typed by hand, where a
//     wrong value is the 32k-squeeze failure class (silent truncation mid-build)
//   · the sampler levers (top_k / repetition_penalty / presence_penalty) flow, and their sliders show

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProvider } from '@cascade/core'
import { listModels, modelInfo, providerCatalog } from '../src/modelCaps'

const MODELS_RESPONSE = JSON.stringify({
	object: 'list',
	data: [{ id: 'Qwen/Qwen3-8B-FP8', object: 'model', max_model_len: 32768 }],
})

afterEach(() => vi.unstubAllGlobals())

describe('native vLLM provider', () => {
	it('is in the provider catalog and configured without a key — it is local', () => {
		const entry = providerCatalog().find((p) => p.id === 'vllm')
		expect(entry).toBeDefined()
		expect(entry?.configured).toBe(true)
	})

	it('lists the served models from /v1/models on the default origin', async () => {
		const fetchMock = vi.fn(async () => new Response(MODELS_RESPONSE, { status: 200 }))
		vi.stubGlobal('fetch', fetchMock)
		expect(await listModels('vllm')).toEqual({ models: ['Qwen/Qwen3-8B-FP8'], reachable: true })
		expect(String(fetchMock.mock.calls[0][0])).toBe('http://127.0.0.1:8000/v1/models')
	})

	it('probes the SERVED context window from max_model_len — no hand-typed number', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response(MODELS_RESPONSE, { status: 200 })))
		const info = await modelInfo('vllm', 'Qwen/Qwen3-8B-FP8')
		expect(info.contextWindow).toBe(32768) // what --max-model-len actually allocated, not the family max
		expect(info.limits.contextMax).toBeGreaterThanOrEqual(32768) // the slider can reach it
	})

	it('exposes the sampler knobs — vLLM is self-hosted serving, not a hosted gateway', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response(MODELS_RESPONSE, { status: 200 })))
		const info = await modelInfo('vllm', 'Qwen/Qwen3-8B-FP8')
		// topK gates the Top K slider AND both penalty sliders in the Model Manager. Hidden, the anti-loop
		// levers this provider exists to test would be unreachable from the UI.
		expect(info.limits.topK).toBe(true)
	})

	it('an unreachable server is REPORTED as unreachable — the UI shows a launch command, not an empty catalog', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))))
		expect(await listModels('vllm')).toEqual({ models: [], reachable: false })
		const info = await modelInfo('vllm', 'Qwen/Qwen3-8B-FP8')
		expect(info.contextWindow).toBeUndefined() // honest: nothing was detected
		expect(info.limits.contextMax).toBeGreaterThan(0) // sliders still bounded sanely
	})

	it('createProvider("vllm") needs NO baseUrl and talks to the vllm-serve default', async () => {
		const provider = createProvider({ provider: 'vllm', model: 'Qwen/Qwen3-8B-FP8' })
		const fetchMock = vi.fn(async () => new Response('data: [DONE]\n\n', { status: 200 }))
		vi.stubGlobal('fetch', fetchMock)
		for await (const _ of provider.stream({ messages: [{ role: 'user', content: 'hi' }], model: 'Qwen/Qwen3-8B-FP8' })) {
			/* drain */
		}
		expect(String(fetchMock.mock.calls[0][0])).toBe('http://127.0.0.1:8000/v1/chat/completions')
	})
})
