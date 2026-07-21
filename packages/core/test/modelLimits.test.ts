import { describe, it, expect } from 'vitest'
import { parseOllamaLimits } from '../src/llm/providers/ollama'

describe('parseOllamaLimits — read the ALLOCATED window from /api/show parameters (ADR-038)', () => {
  it('extracts num_ctx (the Modelfile pin) — the coding-qwen36 128k case', () => {
    // Real Ollama /api/show `parameters` blob shape (name + whitespace + value, one per line).
    const params = 'num_ctx                        131072\nstop                           "<|im_end|>"\ntemperature                    0.7'
    expect(parseOllamaLimits(params)).toEqual({ contextWindow: 131072, maxOutputTokens: undefined })
  })
  it('extracts num_predict when it is a real positive cap', () => {
    expect(parseOllamaLimits('num_ctx 32768\nnum_predict 4096')).toEqual({ contextWindow: 32768, maxOutputTokens: 4096 })
  })
  it('treats num_predict ≤ 0 (unbounded) as no cap', () => {
    expect(parseOllamaLimits('num_ctx 32768\nnum_predict -1')).toEqual({ contextWindow: 32768, maxOutputTokens: undefined })
  })
  it('no num_ctx → contextWindow undefined (caller falls back to the map)', () => {
    expect(parseOllamaLimits('temperature 0.7')).toEqual({ contextWindow: undefined, maxOutputTokens: undefined })
    expect(parseOllamaLimits(undefined)).toEqual({ contextWindow: undefined, maxOutputTokens: undefined })
  })
})
