// The curated ENABLED models (ADR-067) — the extension port of the server's modelRegistry. The composer
// dropdown lists exactly this, across providers.

import { describe, expect, it } from 'vitest'
import { ModelRegistry, type StateStore } from '../src/modelRegistry'

function fakeState(initial?: unknown): StateStore {
	const store = new Map<string, unknown>()
	if (initial !== undefined) store.set('cascade.enabledModels', initial)
	return {
		get: <T>(key: string) => store.get(key) as T | undefined,
		update: async (key: string, value: unknown) => void store.set(key, value),
	}
}

describe('ModelRegistry', () => {
	it('seeds sane cross-provider defaults on first run', () => {
		const r = new ModelRegistry(fakeState())
		const providers = new Set(r.list().map((m) => m.provider))
		expect(providers.has('ollama')).toBe(true)
		expect(providers.has('openai')).toBe(true) // hosted models are listed WITHOUT ever being "used"
	})

	it('add → list (multi-provider) → remove; re-adding an existing entry merges params', async () => {
		const r = new ModelRegistry(fakeState([]))
		await r.add({ provider: 'openai', model: 'gpt-4o-mini', contextWindow: 128_000 })
		await r.add({ provider: 'ollama', model: 'qwen3:8b' })
		expect(r.list().map((m) => `${m.provider}/${m.model}`)).toEqual(['openai/gpt-4o-mini', 'ollama/qwen3:8b'])
		await r.add({ provider: 'openai', model: 'gpt-4o-mini', temperature: 0.3 })
		expect(r.list()).toHaveLength(2) // merged, not duplicated
		expect(r.paramsFor('openai', 'gpt-4o-mini').temperature).toBe(0.3)
		await r.remove('openai', 'gpt-4o-mini')
		expect(r.has('openai', 'gpt-4o-mini')).toBe(false)
	})

	it('the ACTIVE model is always listed even if it was never curated (picker never hides what runs)', () => {
		const r = new ModelRegistry(fakeState([{ provider: 'ollama', model: 'qwen3:8b' }]))
		const list = r.list({ provider: 'openai', model: 'gpt-5.6-luna' })
		expect(list.some((m) => m.provider === 'openai' && m.model === 'gpt-5.6-luna')).toBe(true)
	})

	it('setParams merges onto a model, adding it when absent; paramsFor returns them for activation', async () => {
		const r = new ModelRegistry(fakeState([]))
		await r.setParams('ollama', 'qwen36-agentic:latest', { contextWindow: 65_536 })
		expect(r.has('ollama', 'qwen36-agentic:latest')).toBe(true)
		await r.setParams('ollama', 'qwen36-agentic:latest', { temperature: 0.6 })
		expect(r.paramsFor('ollama', 'qwen36-agentic:latest')).toEqual({ contextWindow: 65_536, temperature: 0.6 })
	})
})
