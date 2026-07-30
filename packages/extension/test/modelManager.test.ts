// Model-manager helpers: catalog + info via the Ollama API (fetch mocked — no live server in tests).

import { afterEach, describe, expect, it, vi } from 'vitest'
import { isOllamaLike, listOllamaModels, ollamaModelInfo } from '../src/modelManager'

afterEach(() => vi.restoreAllMocks())

const jsonRes = (body: unknown) => new Response(JSON.stringify(body))

describe('modelManager helpers', () => {
	it('listOllamaModels: names + humanized sizes; strips a trailing /v1 from the base URL', async () => {
		const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			jsonRes({ models: [{ name: 'qwen36-agentic:latest', size: 25_432_256_670 }, { name: 'nomic-embed-text' }] }),
		)
		const models = await listOllamaModels('http://127.0.0.1:11434/v1')
		expect(String(f.mock.calls[0]![0])).toBe('http://127.0.0.1:11434/api/tags')
		expect(models).toEqual([
			{ name: 'qwen36-agentic:latest', size: '25.4 GB' },
			{ name: 'nomic-embed-text', size: undefined },
		])
	})

	it('listOllamaModels: empty on failure (server down / hosted provider)', async () => {
		vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'))
		expect(await listOllamaModels()).toEqual([])
	})

	it('ollamaModelInfo: Modelfile num_ctx wins; capabilities pass through', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			jsonRes({
				parameters: 'num_ctx            131072\ntemperature        0.7',
				model_info: { 'qwen35moe.context_length': 262144 },
				capabilities: ['completion', 'tools', 'thinking', 'vision'],
			}),
		)
		const info = await ollamaModelInfo('qwen36-agentic:latest')
		expect(info.contextWindow).toBe(131072)
		expect(info.capabilities).toContain('vision')
	})

	it('isOllamaLike gates live detection', () => {
		expect(isOllamaLike('ollama')).toBe(true)
		expect(isOllamaLike('openai')).toBe(false)
	})
})

describe('multi-provider listing (web-manager parity)', () => {
	it('hosted provider: /v1/models with Bearer key; context + capabilities from the shared specs table', async () => {
		const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes({ data: [{ id: 'gpt-4o-mini' }, { id: 'o3' }] }))
		const { listModelsDetailed } = await import('../src/modelManager')
		const { rows, error } = await listModelsDetailed('openai', undefined, 'sk-test')
		expect(error).toBeUndefined()
		expect(String(f.mock.calls[0]![0])).toBe('https://api.openai.com/v1/models')
		expect((f.mock.calls[0]![1] as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer sk-test')
		const gpt = rows.find((r) => r.name === 'gpt-4o-mini')!
		expect(gpt.contextWindow).toBe(128_000) // from core's MODEL_SPECS, not a probe
		expect(gpt.capabilities).toEqual(['tools', 'vision'])
	})

	it('hosted provider without a key: the KNOWN default catalog + a set-a-key note, no fetch', async () => {
		const f = vi.spyOn(globalThis, 'fetch')
		const { listModelsDetailed, DEFAULT_MODELS } = await import('../src/modelManager')
		const prev = process.env.GROQ_API_KEY
		delete process.env.GROQ_API_KEY
		delete process.env.CASCADE_API_KEY
		const { rows, note, error } = await listModelsDetailed('groq')
		if (prev) process.env.GROQ_API_KEY = prev
		expect(error).toBeUndefined()
		expect(note).toContain('Set an API key')
		expect(rows.map((r) => r.name)).toEqual(DEFAULT_MODELS.groq)
		expect(f).not.toHaveBeenCalled()
	})
})

describe('key handling + default catalogs', () => {
	it('keyFor precedence: secret > settings > env', async () => {
		const { keyFor } = await import('../src/modelManager')
		process.env.OPENAI_API_KEY = 'env-key'
		expect(keyFor('openai', 'settings-key', 'secret-key')).toBe('secret-key')
		expect(keyFor('openai', 'settings-key')).toBe('settings-key')
		expect(keyFor('openai')).toBe('env-key')
		delete process.env.OPENAI_API_KEY
	})

	it('no key → default catalog from the SHARED specs (same values the web UI shows), with a note not an error', async () => {
		const f = vi.spyOn(globalThis, 'fetch')
		const { listModelsDetailed } = await import('../src/modelManager')
		delete process.env.OPENAI_API_KEY
		delete process.env.CASCADE_API_KEY
		const { rows, note, error } = await listModelsDetailed('openai')
		expect(error).toBeUndefined()
		expect(note).toContain('known openai models')
		expect(f).not.toHaveBeenCalled()
		const luna = rows.find((r) => r.name === 'gpt-5.6-luna')!
		expect(luna.contextWindow).toBe(1_048_576) // core MODEL_SPECS — byte-identical to the web manager
		expect(luna.capabilities).toEqual(['tools', 'vision'])
	})
})

describe('ollama pullable suggestions', () => {
	it('suggests popular models minus families already installed; suggestions survive an unreachable server', async () => {
		const { listModelsDetailed } = await import('../src/modelManager')
		// installed: qwen36-agentic (family qwen36-agentic) + qwen3:30b → qwen3 family suggestions filtered
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
			if (String(url).includes('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'qwen3:30b', size: 18e9 }] }))
			return new Response(JSON.stringify({ capabilities: ['completion'], parameters: 'num_ctx 131072' }))
		})
		const { rows, suggestions } = await listModelsDetailed('ollama')
		expect(rows.map((r) => r.name)).toEqual(['qwen3:30b'])
		const names = suggestions!.map((s) => s.name)
		expect(names).not.toContain('qwen3:8b') // family installed → hidden
		expect(names).toContain('gemma3:12b') // not installed → suggested, with spec context
		expect(suggestions!.find((s) => s.name === 'gemma3:12b')!.contextWindow).toBe(131_072)

		vi.restoreAllMocks()
		vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'))
		const down = await listModelsDetailed('ollama')
		expect(down.rows).toEqual([])
		expect(down.error).toContain('is Ollama running')
		expect(down.suggestions!.length).toBeGreaterThan(5) // catalog still shown when the server is down
	})
})
