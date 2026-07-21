// modelCaps.ts — model capability detection (ADR-060 Phase 0). Ollama's /api/show reports a `capabilities`
// list (completion/tools/thinking/vision — verified against qwen36-agentic 2026-07-20); the Browser tool is
// injected ONLY when `vision` is present, so non-vision models never see a tool they can't use (the
// inert-by-default rule). Cached per model per process — capabilities don't change under a running server.
//
// Hosted providers (openai/nvidia/openrouter/…) have no /api/show, so vision comes from a static list of
// famously-multimodal families instead of a live probe. Same inert-by-default rule: a hosted model not on
// the list claims nothing and the Browser tool stays off — a wrong OFF degrades gracefully, a wrong ON
// hands the model a tool that errors on every screenshot.

const cache = new Map<string, string[]>()

/** Hosted model families with vision. Matches plain ids ("gpt-5-mini") and gateway-prefixed ids
 *  ("openai/gpt-4o" on OpenRouter, "meta/llama-3.2-90b-vision-instruct" on NVIDIA NIM). */
const HOSTED_VISION = /gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|\bo[134]\b|\bo[134]-|claude|gemini|vision|llava|qwen[^/]*-?vl|pixtral|internvl/i

/** The model's capability list: Ollama → live /api/show probe; hosted → static family knowledge.
 *  Empty on any failure — absence of proof gates features OFF. */
export async function modelCapabilities(model: string, baseUrl?: string, provider = 'ollama'): Promise<string[]> {
  if (provider !== 'ollama') return HOSTED_VISION.test(model) ? ['vision'] : []
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
