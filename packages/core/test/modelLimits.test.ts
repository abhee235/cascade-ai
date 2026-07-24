import { describe, it, expect } from 'vitest'
import { archContextLength, parseOllamaLimits } from '../src/llm/providers/ollama'

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
  it('no num_ctx → contextWindow undefined (caller falls back to the arch ceiling, then the map)', () => {
    expect(parseOllamaLimits('temperature 0.7')).toEqual({ contextWindow: undefined, maxOutputTokens: undefined })
    expect(parseOllamaLimits(undefined)).toEqual({ contextWindow: undefined, maxOutputTokens: undefined })
  })
})

describe('archContextLength — the trained ceiling fallback when the Modelfile pins no num_ctx (gpt-oss:20b)', () => {
  it('reads the architecture-namespaced *.context_length', () => {
    // Real /api/show model_info shape for gpt-oss:20b.
    expect(archContextLength({ 'gptoss.context_length': 131072, 'gptoss.block_count': 24 })).toBe(131072)
  })
  it('ignores rope original_context_length (the 4k pre-scaling value, NOT the usable window)', () => {
    // Must pick gptoss.context_length (131072), never gptoss.rope.scaling.original_context_length (4096).
    expect(archContextLength({ 'gptoss.rope.scaling.original_context_length': 4096, 'gptoss.context_length': 131072 })).toBe(131072)
  })
  it('undefined when model_info is missing or has no context_length', () => {
    expect(archContextLength(undefined)).toBeUndefined()
    expect(archContextLength({ 'gptoss.block_count': 24 })).toBeUndefined()
  })
})
