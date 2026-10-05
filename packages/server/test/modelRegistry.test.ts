// ADR-067 — the enabled-model registry: curated picker list + editable per-model params (context window,
// output cap, sampling) persisted to disk and merged (never clobbered) on update.

import { beforeEach, describe, expect, it } from 'vitest'
import { activeModel, addEnabledModel, enabledModels, initModelRegistry, modelParamsFor, removeEnabledModel, setActiveModel, setModelContext, setModelParams } from '../src/modelRegistry'

// ADR-081: the registry now persists through a ConfigStore rather than a JSON file, so the harness is an
// IN-MEMORY store. That is a better test than a temp dir was: it exercises the port the desktop and a
// hosted deployment both implement, instead of one backend's file layout.
function memoryConfig() {
  let models = []
  let connectors = []
  let active
  const settings = new Map()
  const same = (a, p, m) => a.provider === p && a.model === m
  return {
    async models() { return models.map((m) => ({ ...m })) },
    async upsertModel(m) {
      const i = models.findIndex((x) => same(x, m.provider, m.model))
      if (i >= 0) models[i] = { ...models[i], ...m }
      else models.push({ ...m })
    },
    async removeModel(p, m) { models = models.filter((x) => !same(x, p, m)) },
    async activeModel() { return active },
    async setActiveModel(a) { active = { ...a } },
    async connectors() { return connectors.map((c) => ({ ...c })) },
    async upsertConnector(c) {
      const i = connectors.findIndex((x) => x.name === c.name)
      if (i >= 0) connectors[i] = { ...connectors[i], ...c }
      else connectors.push({ ...c })
    },
    async removeConnector(name) { connectors = connectors.filter((c) => c.name !== name) },
    async setting(k) { return settings.get(k) },
    async setSetting(k, v) { settings.set(k, v) },
    /** Test seam: corrupt/replace what a reload will see. */
    _setActive(a) { active = a },
  }
}
/** Writes are fire-and-forget by design (a config write must never block a request handler), so a test
 *  that reloads has to let those microtasks settle first. */
const settled = () => new Promise((r) => setTimeout(r, 0))

let store: ReturnType<typeof memoryConfig>
beforeEach(async () => {
	store = memoryConfig()
	await initModelRegistry(store as never)
})

describe('modelRegistry per-model params (ADR-067)', () => {
	it('seeds defaults when no file exists', async () => {
		const list = enabledModels()
		expect(list.length).toBeGreaterThan(0)
		expect(list.some((m) => m.provider === 'openai' && m.model === 'gpt-6-luna')).toBe(true)
	})

	it('setModelParams merges without clobbering other fields', async () => {
		addEnabledModel('ollama', 'qwen36-agentic', 32768)
		setModelParams('ollama', 'qwen36-agentic', { temperature: 0.4 })
		setModelParams('ollama', 'qwen36-agentic', { topK: 40, topP: 0.9 })
		const p = modelParamsFor('ollama', 'qwen36-agentic')
		// context from addEnabledModel survives both param merges
		expect(p).toEqual({ contextWindow: 32768, temperature: 0.4, topK: 40, topP: 0.9 })
	})

	it('an explicit undefined field clears just that override', async () => {
		setModelParams('openai', 'gpt-4.1', { temperature: 0.7, maxOutputTokens: 4096 })
		setModelParams('openai', 'gpt-4.1', { temperature: undefined })
		const p = modelParamsFor('openai', 'gpt-4.1')
		expect(p.temperature).toBeUndefined()
		expect(p.maxOutputTokens).toBe(4096)
	})

	it('adds a model on first setModelParams if it was not enabled yet', async () => {
		setModelParams('nvidia', 'some-model', { contextWindow: 16384 })
		expect(enabledModels().some((m) => m.provider === 'nvidia' && m.model === 'some-model')).toBe(true)
		expect(modelParamsFor('nvidia', 'some-model').contextWindow).toBe(16384)
	})

	it('persists across a re-init (reload from disk)', async () => {
		setModelParams('ollama', 'llama3.3', { contextWindow: 8192, topK: 20 })
		await settled()
		await initModelRegistry(store as never) // fresh cache → reloads from the store
		expect(modelParamsFor('ollama', 'llama3.3')).toEqual({ contextWindow: 8192, topK: 20 })
	})

	it('setModelContext still works and leaves sampling params intact', async () => {
		setModelParams('ollama', 'qwen36-agentic', { temperature: 0.5 })
		setModelContext('ollama', 'qwen36-agentic', 65536)
		const p = modelParamsFor('ollama', 'qwen36-agentic')
		expect(p.contextWindow).toBe(65536)
		expect(p.temperature).toBe(0.5)
	})

	it('removeEnabledModel drops it and its params', async () => {
		addEnabledModel('ollama', 'temp-model')
		removeEnabledModel('ollama', 'temp-model')
		expect(enabledModels().some((m) => m.model === 'temp-model')).toBe(false)
		expect(modelParamsFor('ollama', 'temp-model')).toEqual({})
	})
})

// The SELECTION, not just the list. Measured: `active` lived only in ProjectManager memory, so every server
// restart silently reverted to CASCADE_PROVIDER/CASCADE_MODEL — a chosen local Ollama model quietly became a
// paid hosted one again, with only a small label to give it away.
describe('active model selection survives a restart (ADR-067)', () => {
	it('is undefined on first run, so the env default still seeds the server', async () => {
		expect(activeModel()).toBeUndefined()
	})

	it('round-trips the selection through disk (a restart re-reads it)', async () => {
		setActiveModel({ provider: 'ollama', model: 'qwen36-agentic' })
		await settled()
		await initModelRegistry(store as never) // simulate the restart: caches dropped, same store
		expect(activeModel()).toEqual({ provider: 'ollama', model: 'qwen36-agentic' })
	})

	it('keeps baseUrl for custom endpoints, where the id alone cannot locate the backend', async () => {
		setActiveModel({ provider: 'vllm-box', model: 'qwen3-32b', baseUrl: 'http://10.0.0.4:8000' })
		await settled()
		await initModelRegistry(store as never)
		expect(activeModel()?.baseUrl).toBe('http://10.0.0.4:8000')
	})

	it('a corrupt selection file degrades to the env default, never taking the curated list down with it', async () => {
		setActiveModel({ provider: 'ollama', model: 'qwen36-agentic' })
		// A stored selection that cannot be read (corrupt row, hand-edited file in the old world) must
		// degrade to "nothing selected", never take the curated list down with it.
		store._setActive(undefined)
		await initModelRegistry(store as never)
		expect(activeModel()).toBeUndefined()
		expect(enabledModels().length).toBeGreaterThan(0) // the list is a SEPARATE file — untouched
	})
})
