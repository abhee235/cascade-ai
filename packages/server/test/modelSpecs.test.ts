// ADR-067 — per-model spec limits: the sliders range over a model's OFFICIAL max context/output/temperature
// and expose top_k only where the API does. Match is most-specific-substring-first; unknown ⇒ default ceiling.

import { describe, expect, it } from 'vitest'
import { DEFAULT_LIMITS, limitsFor, specCapabilities } from '../src/modelSpecs'

describe('limitsFor (ADR-067)', () => {
	it('resolves a hosted OpenAI model to its official ceilings, no top_k', () => {
		const l = limitsFor('openai', 'gpt-4.1')
		expect(l.contextMax).toBe(1_047_576)
		expect(l.outputMax).toBe(32_768)
		expect(l.topK).toBe(false)
	})

	it('fixes temperature at 1 for reasoning models (o-series / gpt-5)', () => {
		expect(limitsFor('openai', 'o3').tempMax).toBe(1)
		expect(limitsFor('openai', 'gpt-5.6-luna').tempMax).toBe(1) // gpt-5 family
		expect(limitsFor('openai', 'gpt-4o').tempMax).toBe(2) // non-reasoning chat is tunable
	})

	it('matches most-specific first (mini before base)', () => {
		expect(limitsFor('openai', 'gpt-4o-mini').outputMax).toBe(16_384)
		// llama3.2-vision must win over llama3.2
		expect(limitsFor('ollama', 'llama3.2-vision:11b').contextMax).toBe(131_072)
	})

	it('open-weight families expose top_k on Ollama but NOT via a hosted gateway', () => {
		expect(limitsFor('ollama', 'qwen36-agentic').topK).toBe(true) // qwen3 family, native Ollama
		expect(limitsFor('ollama', 'qwen36-agentic').outputMax).toBe(32_768) // qwen3 output
		// same open-weight family, but served by Groq/NIM (OpenAI-compat) ⇒ no top_k
		expect(limitsFor('groq', 'llama-3.3-70b-versatile').topK).toBe(false)
		expect(limitsFor('nvidia', 'llama-3.3-nemotron').topK).toBe(false)
	})

	it('unknown model falls back to the default ceiling; top_k follows the provider', () => {
		expect(limitsFor('ollama', 'some-random-model').contextMax).toBe(DEFAULT_LIMITS.contextMax)
		expect(limitsFor('ollama', 'some-random-model').topK).toBe(true)
		expect(limitsFor('nvidia', 'some-random-model').topK).toBe(false)
	})

	it('a live-detected window raises the ceiling beyond the table/default', () => {
		// a Modelfile pinned larger than the family default must still fit on the slider
		expect(limitsFor('ollama', 'mistral', 200_000).contextMax).toBe(200_000) // mistral table = 32768
		expect(limitsFor('ollama', 'mistral', 8_000).contextMax).toBe(32_768) // smaller detected doesn't shrink it
	})
})

describe('specCapabilities (hosted badges)', () => {
	it('reports tools+vision for a multimodal hosted model', () => {
		expect(specCapabilities('gpt-4.1')).toEqual(['tools', 'vision'])
	})
	it('reports tools-only where vision is absent', () => {
		expect(specCapabilities('qwen2.5-coder')).toEqual(['tools'])
	})
	it('returns undefined for an unknown model (caller keeps its own detection)', () => {
		expect(specCapabilities('totally-unknown')).toBeUndefined()
	})
})
