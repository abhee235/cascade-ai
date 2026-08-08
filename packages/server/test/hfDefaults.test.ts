// HF-sourced model defaults — the "best settings" live in the repo, not in a search engine.
//
// config.json carries max_position_embeddings (native context); generation_config.json carries the
// AUTHOR's recommended sampling. The fixture below is the real shape of Qwen/Qwen3-8B's files.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchHfDefaults, hfRepoOf } from '../src/hfDefaults'

const CONFIG = JSON.stringify({ architectures: ['Qwen3ForCausalLM'], max_position_embeddings: 40960 })
const GEN = JSON.stringify({ temperature: 0.6, top_p: 0.95, top_k: 20, repetition_penalty: 1.0, do_sample: true })

afterEach(() => vi.unstubAllGlobals())

describe('hfRepoOf', () => {
	it('accepts org/name ids and normalizes Ollama hf.co pulls', () => {
		expect(hfRepoOf('Qwen/Qwen3-8B-FP8')).toBe('Qwen/Qwen3-8B-FP8')
		expect(hfRepoOf('nvidia/Qwen3-8B-FP4')).toBe('nvidia/Qwen3-8B-FP4')
		// Ollama's HF pull syntax: strip the prefix and the :quant tag → the repo the files live in.
		expect(hfRepoOf('hf.co/unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ4_XS')).toBe('unsloth/Qwen3.6-35B-A3B-GGUF')
	})

	it('rejects everything that is not an HF repo path', () => {
		// Plain Ollama tags and hosted ids must not trigger requests to huggingface.co at all.
		expect(hfRepoOf('qwen36-agentic')).toBeUndefined()
		expect(hfRepoOf('gpt-5.6-luna')).toBeUndefined()
		expect(hfRepoOf('a/b/c')).toBeUndefined()
	})
})

describe('fetchHfDefaults', () => {
	it('reads context from config.json and the author sampling from generation_config.json', async () => {
		const fetchMock = vi.fn(async (url: string) => new Response(String(url).endsWith('generation_config.json') ? GEN : CONFIG, { status: 200 }))
		vi.stubGlobal('fetch', fetchMock)

		const d = await fetchHfDefaults('Qwen/Qwen3-8B-FP8')
		expect(d).toEqual({ contextWindow: 40960, temperature: 0.6, topP: 0.95, topK: 20, repeatPenalty: 1.0 })
		const urls = fetchMock.mock.calls.map((c) => String(c[0]))
		expect(urls).toContain('https://huggingface.co/Qwen/Qwen3-8B-FP8/resolve/main/config.json')
		expect(urls).toContain('https://huggingface.co/Qwen/Qwen3-8B-FP8/resolve/main/generation_config.json')
	})

	it('still returns the context when generation_config.json is absent (quant repos often omit it)', async () => {
		vi.stubGlobal('fetch', vi.fn(async (url: string) => (String(url).endsWith('config.json') && !String(url).includes('generation') ? new Response(CONFIG, { status: 200 }) : new Response('not found', { status: 404 }))))
		const d = await fetchHfDefaults('unsloth/some-GGUF-repo')
		expect(d).toEqual({ contextWindow: 40960, temperature: undefined, topP: undefined, topK: undefined, repeatPenalty: undefined })
	})

	it('returns undefined for a non-HF id WITHOUT any network call', async () => {
		const fetchMock = vi.fn()
		vi.stubGlobal('fetch', fetchMock)
		expect(await fetchHfDefaults('qwen36-agentic')).toBeUndefined()
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('degrades to undefined when huggingface.co is unreachable — adding a model must never fail on it', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('offline'))))
		expect(await fetchHfDefaults('Some/OfflineModel')).toBeUndefined()
	})
})
