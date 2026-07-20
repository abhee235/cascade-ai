// modelCaps.ts — model capability detection (ADR-060 Phase 0). Ollama's /api/show reports a `capabilities`
// list (completion/tools/thinking/vision — verified against qwen36-agentic 2026-07-20); the Browser tool is
// injected ONLY when `vision` is present, so non-vision models never see a tool they can't use (the
// inert-by-default rule). Cached per model per process — capabilities don't change under a running server.

const cache = new Map<string, string[]>()

/** The model's capability list from /api/show (empty on any failure — absence of proof gates features OFF). */
export async function modelCapabilities(model: string, baseUrl?: string): Promise<string[]> {
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

export async function hasVision(model: string, baseUrl?: string): Promise<boolean> {
  return (await modelCapabilities(model, baseUrl)).includes('vision')
}
