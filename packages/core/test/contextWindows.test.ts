import { describe, it, expect } from 'vitest'
import { contextWindowForModel } from '../src/llm/contextWindows'

// The map is a hosted model's ONLY window source (detectModelLimits is Ollama-only), so a wrong/missing
// entry means the compactor sizes a NIM model at the 8k default and compacts ~16× too early.
describe('contextWindowForModel — hosted NIM coder models', () => {
  it('sizes Kimi K2 variants (base 128k, 0905/2.5/2.6 256k)', () => {
    expect(contextWindowForModel('moonshotai/kimi-k2-instruct')).toBe(131_072)
    expect(contextWindowForModel('moonshotai/kimi-k2-instruct-0905')).toBe(262_144)
    expect(contextWindowForModel('moonshotai/kimi-k2.6')).toBe(262_144)
  })

  it('sizes Qwen3-Coder at 256k — BEFORE the generic qwen 32k rule', () => {
    expect(contextWindowForModel('qwen/qwen3-coder-480b-a35b-instruct')).toBe(262_144)
    // the generic qwen rule still applies to non-coder qwen3
    expect(contextWindowForModel('qwen/qwen3-32b')).toBe(32_768)
  })

  it('sizes DeepSeek V3/R1 at 128k — BEFORE the generic deepseek 32k rule', () => {
    expect(contextWindowForModel('deepseek-ai/deepseek-v3.1')).toBe(131_072)
    expect(contextWindowForModel('deepseek-ai/deepseek-r1')).toBe(131_072)
    // an older/other deepseek with no v3/r1 marker still hits the conservative generic rule
    expect(contextWindowForModel('deepseek-coder:6.7b')).toBe(32_768)
  })

  it('sizes Llama 3.1/3.3/Nemotron at 128k without breaking the local llama3 → 8k default', () => {
    expect(contextWindowForModel('meta/llama-3.1-70b-instruct')).toBe(131_072)
    expect(contextWindowForModel('nvidia/llama-3.1-nemotron-70b-instruct')).toBe(131_072)
    expect(contextWindowForModel('llama3:8b')).toBe(8_192) // local base llama3 stays conservative
  })

  it('sizes gpt-6-luna at its 1.05M window, not the gpt-5 400k rule or the 8k default', () => {
    expect(contextWindowForModel('gpt-6-luna')).toBe(1_050_000)
    expect(contextWindowForModel('gpt-5.6-luna')).toBe(400_000) // unchanged: the generic gpt-5 rule
  })

  it('returns undefined for a model it has never heard of (caller uses the override / default)', () => {
    expect(contextWindowForModel('some-unknown/model-x')).toBeUndefined()
  })
})
