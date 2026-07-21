// ADR-067 — the enabled-model registry: curated picker list + editable per-model params (context window,
// output cap, sampling) persisted to disk and merged (never clobbered) on update.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addEnabledModel, enabledModels, initModelRegistry, modelParamsFor, removeEnabledModel, setModelContext, setModelParams } from '../src/modelRegistry'

let root = ''
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'cascade-registry-'))
	initModelRegistry(root)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('modelRegistry per-model params (ADR-067)', () => {
	it('seeds defaults when no file exists', () => {
		const list = enabledModels()
		expect(list.length).toBeGreaterThan(0)
		expect(list.some((m) => m.provider === 'openai' && m.model === 'gpt-5.6-luna')).toBe(true)
	})

	it('setModelParams merges without clobbering other fields', () => {
		addEnabledModel('ollama', 'qwen36-agentic', 32768)
		setModelParams('ollama', 'qwen36-agentic', { temperature: 0.4 })
		setModelParams('ollama', 'qwen36-agentic', { topK: 40, topP: 0.9 })
		const p = modelParamsFor('ollama', 'qwen36-agentic')
		// context from addEnabledModel survives both param merges
		expect(p).toEqual({ contextWindow: 32768, temperature: 0.4, topK: 40, topP: 0.9 })
	})

	it('an explicit undefined field clears just that override', () => {
		setModelParams('openai', 'gpt-4.1', { temperature: 0.7, maxOutputTokens: 4096 })
		setModelParams('openai', 'gpt-4.1', { temperature: undefined })
		const p = modelParamsFor('openai', 'gpt-4.1')
		expect(p.temperature).toBeUndefined()
		expect(p.maxOutputTokens).toBe(4096)
	})

	it('adds a model on first setModelParams if it was not enabled yet', () => {
		setModelParams('nvidia', 'some-model', { contextWindow: 16384 })
		expect(enabledModels().some((m) => m.provider === 'nvidia' && m.model === 'some-model')).toBe(true)
		expect(modelParamsFor('nvidia', 'some-model').contextWindow).toBe(16384)
	})

	it('persists across a re-init (reload from disk)', () => {
		setModelParams('ollama', 'llama3.3', { contextWindow: 8192, topK: 20 })
		initModelRegistry(root) // fresh cache → reads the file
		expect(modelParamsFor('ollama', 'llama3.3')).toEqual({ contextWindow: 8192, topK: 20 })
	})

	it('setModelContext still works and leaves sampling params intact', () => {
		setModelParams('ollama', 'qwen36-agentic', { temperature: 0.5 })
		setModelContext('ollama', 'qwen36-agentic', 65536)
		const p = modelParamsFor('ollama', 'qwen36-agentic')
		expect(p.contextWindow).toBe(65536)
		expect(p.temperature).toBe(0.5)
	})

	it('removeEnabledModel drops it and its params', () => {
		addEnabledModel('ollama', 'temp-model')
		removeEnabledModel('ollama', 'temp-model')
		expect(enabledModels().some((m) => m.model === 'temp-model')).toBe(false)
		expect(modelParamsFor('ollama', 'temp-model')).toEqual({})
	})
})
