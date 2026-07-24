// modelCaps.ts — model capability detection (ADR-060 Phase 0). Ollama's /api/show reports a `capabilities`
// list (completion/tools/thinking/vision — verified against qwen36-agentic 2026-07-20); the Browser tool is
// injected ONLY when `vision` is present, so non-vision models never see a tool they can't use (the
// inert-by-default rule). Cached per model per process — capabilities don't change under a running server.
//
// Hosted providers (openai/nvidia/openrouter/…) have no /api/show, so vision comes from a static list of
// famously-multimodal families instead of a live probe. Same inert-by-default rule: a hosted model not on
// the list claims nothing and the Browser tool stays off — a wrong OFF degrades gracefully, a wrong ON
// hands the model a tool that errors on every screenshot.

import { archContextLength, ARCH_FALLBACK_CAP } from '@cascade/core'
import { limitsFor, type ModelLimits, specCapabilities } from './modelSpecs.js'

const cache = new Map<string, string[]>()

// ── ADR-067: provider catalog + model listing (for the runtime model picker) ────────────────────────────
// Default origins + conventional key env vars per provider (mirrors the core factory; kept here so the
// server can list models + report which providers are configured without importing core internals).
const BASE_URLS: Record<string, string> = {
  ollama: 'http://127.0.0.1:11434',
  openai: 'https://api.openai.com',
  nvidia: 'https://integrate.api.nvidia.com',
  groq: 'https://api.groq.com/openai',
  openrouter: 'https://openrouter.ai/api',
}
const KEY_ENV: Record<string, string> = { openai: 'OPENAI_API_KEY', nvidia: 'NVIDIA_API_KEY', groq: 'GROQ_API_KEY', openrouter: 'OPENROUTER_API_KEY' }

export interface ProviderCatalogEntry {
  id: string
  /** True if this provider can be used now: local (ollama) or has a key in the environment. */
  configured: boolean
}

/** The providers the UI can offer, with whether each is usable (local, or an env key is present). Custom
 *  endpoints (any other id + a baseUrl) are still allowed via setModel — this is just the known menu. */
export function providerCatalog(): ProviderCatalogEntry[] {
  return Object.keys(BASE_URLS).map((id) => ({
    id,
    configured: id === 'ollama' || !!(process.env[KEY_ENV[id]] || process.env.CASCADE_API_KEY),
  }))
}

/** Rich info for ONE model, for the manager UI: capabilities (tools/vision/thinking/completion), the live
 *  context window when knowable (Ollama /api/show num_ctx), and the per-model LIMITS (official max context /
 *  output / temperature + whether top_k applies) that bound the config sliders (ADR-067). */
export async function modelInfo(provider: string, model: string, baseUrl?: string): Promise<{ capabilities: string[]; contextWindow?: number; limits: ModelLimits }> {
  const capabilities = await modelCapabilities(model, baseUrl, provider)
  let contextWindow: number | undefined
  let archMax: number | undefined
  if (provider === 'ollama') {
    try {
      const base = (baseUrl ?? BASE_URLS.ollama).replace(/\/v1\/?$/, '')
      const res = await fetch(`${base}/api/show`, { method: 'POST', body: JSON.stringify({ model }), signal: AbortSignal.timeout(5000) })
      const j = (await res.json()) as { parameters?: string; model_info?: Record<string, unknown> }
      const m = (j.parameters ?? '').match(/^\s*num_ctx\s+(\d+)/m)
      archMax = archContextLength(j.model_info)
      // Modelfile num_ctx is the deliberate allocation; otherwise default to the arch ceiling CAPPED — the
      // SAME rule as core's detectModelLimits, so the window the UI shows equals the one the harness runs
      // (no silent 8k fallback for a model whose Modelfile pins nothing, e.g. gpt-oss:20b).
      if (m) contextWindow = Number(m[1])
      else if (archMax) contextWindow = Math.min(archMax, ARCH_FALLBACK_CAP)
    } catch {
      /* unreachable — leave undefined */
    }
  }
  // The slider max reaches the TRUE ceiling (archMax) so the user can raise the window to what the model
  // supports; the detected value stays the safe default.
  return { capabilities, contextWindow, limits: limitsFor(provider, model, Math.max(contextWindow ?? 0, archMax ?? 0) || undefined) }
}

/** Set a provider's API key for the RUNNING server (process.env). Session-scoped — not written to disk
 *  (keys belong in .env for persistence). Returns whether the provider is now configured. */
export function setProviderKey(provider: string, key: string): boolean {
  const env = KEY_ENV[provider]
  if (!env) return false
  if (key.trim()) process.env[env] = key.trim()
  else delete process.env[env]
  return !!process.env[env]
}

/** List the models a provider offers, live: Ollama → /api/tags; OpenAI-compatible → /v1/models (with the
 *  env key). Empty on any failure (no key, unreachable, unknown provider) — never throws. */
export async function listModels(provider: string, baseUrl?: string): Promise<string[]> {
  const base = (baseUrl ?? BASE_URLS[provider] ?? '').replace(/\/$/, '')
  if (!base) return []
  try {
    if (provider === 'ollama') {
      const res = await fetch(`${base.replace(/\/v1$/, '')}/api/tags`, { signal: AbortSignal.timeout(5000) })
      const j = (await res.json()) as { models?: { name: string }[] }
      return (j.models ?? []).map((m) => m.name).sort()
    }
    const key = process.env[KEY_ENV[provider]] || process.env.CASCADE_API_KEY
    const res = await fetch(`${base}/v1/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(8000) })
    if (!res.ok) return []
    const j = (await res.json()) as { data?: { id: string }[] }
    return (j.data ?? []).map((m) => m.id).sort()
  } catch {
    return []
  }
}

/** Hosted model families with vision. Matches plain ids ("gpt-5-mini") and gateway-prefixed ids
 *  ("openai/gpt-4o" on OpenRouter, "meta/llama-3.2-90b-vision-instruct" on NVIDIA NIM). */
const HOSTED_VISION = /gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|\bo[134]\b|\bo[134]-|claude|gemini|vision|llava|qwen[^/]*-?vl|pixtral|internvl/i

/** The model's capability list: Ollama → live /api/show probe; hosted → static family knowledge.
 *  Empty on any failure — absence of proof gates features OFF. */
export async function modelCapabilities(model: string, baseUrl?: string, provider = 'ollama'): Promise<string[]> {
  // Hosted models have no /api/show probe: prefer the spec table (tools + vision), fall back to the vision regex.
  if (provider !== 'ollama') return specCapabilities(model) ?? (HOSTED_VISION.test(model) ? ['vision'] : [])
  const key = `${baseUrl ?? ''}|${model}`
  const hit = cache.get(key)
  if (hit) return hit
  try {
    const base = (baseUrl ?? 'http://127.0.0.1:11434').replace(/\/v1\/?$/, '') // native endpoint, not /v1
    const res = await fetch(`${base}/api/show`, { method: 'POST', body: JSON.stringify({ model }), signal: AbortSignal.timeout(5000) })
    const j = (await res.json()) as { capabilities?: string[] }
    const caps = Array.isArray(j.capabilities) ? j.capabilities : []
    cache.set(key, caps)
    return caps
  } catch {
    return [] // backend unreachable / not Ollama — no capabilities claimed, features stay off
  }
}

export async function hasVision(model: string, baseUrl?: string, provider = 'ollama'): Promise<boolean> {
  return (await modelCapabilities(model, baseUrl, provider)).includes('vision')
}
