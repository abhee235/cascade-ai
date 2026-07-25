// llm/factory.ts — build a ModelProvider from configuration.
//
// The frontend (extension/web/server) reads config (provider id, model, baseUrl, apiKey) and calls
// createProvider(); the result is injected into createSession(). The core depends on the interface,
// the factory owns the "which concrete provider" decision. Add a new provider in ONE place here.

import type { ModelProvider } from './provider'
import { OpenAIChatProvider } from './providers/openaiChat'
import { OpenAIResponsesProvider } from './providers/openaiResponses'
import { OllamaProvider } from './providers/ollama'

export interface ProviderConfig {
  /** A KNOWN id ("ollama" | "llamacpp" | "openai" | "groq" | "openrouter" | "nvidia") — or ANY other
   *  id when `baseUrl` is set: every OpenAI-compatible endpoint (Together, Fireworks, vLLM, LM Studio,
   *  Azure-compat gateways…) works through the generic adapter, the id then only labels logs/traces. */
  provider: string
  model: string
  /** Optional override; falls back to the provider's default origin below. REQUIRED for unknown ids. */
  baseUrl?: string
  /** Explicit key wins; omitted ⇒ resolved from the provider's conventional env var (see API_KEY_ENV),
   *  falling back to CASCADE_API_KEY — so keys live in .env / the shell, never in committed settings. */
  apiKey?: string
  /** Backend-native load/runtime options passed through VERBATIM by adapters that support them (Ollama:
   *  merged into /api/chat `options`, e.g. `{ num_gpu: 40 }` to trade offloaded layers for VRAM headroom).
   *  This is adapter CONFIG, not core knowledge — core never reads it; other backends ignore it. */
  options?: Record<string, unknown>
  /** WIRE PROTOCOL override (ADR-077). Normally the adapter is chosen by `provider` id, which breaks for a
   *  REMOTE Ollama: it's reached under a custom id (e.g. "vast"), so it fell through to the generic /v1
   *  adapter. That still generates fine, but Ollama's OpenAI-compat layer reports only token COUNTS —
   *  measured 2026-07-25: a rented Ollama box produced zero prefill/decode timings, so the KV-cache and
   *  throughput observables we tune against (ADR-040) all read 0. Set 'ollama' to force the NATIVE
   *  /api/chat adapter against `baseUrl` and get promptEvalMs/decodeMs/loadMs back. */
  api?: 'openai' | 'ollama'
}

// Origins for OpenAI-compatible providers. We append /v1/chat/completions to these.
const OPENAI_COMPAT_BASE_URLS: Record<string, string> = {
  ollama: 'http://127.0.0.1:11434',
  llamacpp: 'http://127.0.0.1:8080',
  openai: 'https://api.openai.com',
  groq: 'https://api.groq.com/openai',
  openrouter: 'https://openrouter.ai/api',
  nvidia: 'https://integrate.api.nvidia.com', // NIM: OpenAI-compatible /v1/chat/completions
}

// Conventional env var per provider — the names every vendor's own docs tell users to export. Resolution
// order: explicit config > provider-specific var > CASCADE_API_KEY (the generic/custom-endpoint fallback).
const API_KEY_ENV: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  groq: 'GROQ_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  nvidia: 'NVIDIA_API_KEY',
}

function resolveApiKey(id: string, explicit?: string): string | undefined {
  if (explicit) return explicit
  if (typeof process === 'undefined') return undefined // core can run outside Node (webview never does, but stay safe)
  const specific = API_KEY_ENV[id] && process.env[API_KEY_ENV[id]]
  return specific || process.env.CASCADE_API_KEY || undefined
}

export function createProvider(cfg: ProviderConfig): ModelProvider {
  const id = cfg.provider.toLowerCase()

  if (id === 'anthropic') {
    // This provider uses a different wire format (/v1/messages, x-api-key). Its own provider lands
    // when we need it — kept out of the OpenAI-compat path on purpose.
    throw new Error('Provider "anthropic" not implemented yet (needs a dedicated AnthropicProvider).')
  }

  // NORMALIZE the endpoint: the providers append their own path (`/v1/chat/completions`, `/api/chat`), so a
  // baseUrl that already ends in `/v1` (what OpenAI SDKs + the vLLM/Vast docs show, and what a user naturally
  // pastes) would double to `/v1/v1/...`. Strip a trailing slash and a trailing `/v1` so either form works.
  const baseUrl = (cfg.baseUrl || OPENAI_COMPAT_BASE_URLS[id])?.replace(/\/+$/, '').replace(/\/v1$/, '')
  if (!baseUrl) {
    throw new Error(
      `Unknown provider "${cfg.provider}" and no baseUrl given. Known: ${Object.keys(OPENAI_COMPAT_BASE_URLS).join(', ')} — or pass any OpenAI-compatible endpoint via baseUrl.`,
    )
  }

  // Pick the wire adapter by id. Most vendors share the chat/completions base; only Ollama (native
  // /api/chat) and OpenAI (Responses) need a specialization. A new OpenAI-compatible vendor needs NO
  // code here — it flows through OpenAIChatProvider via its base-URL entry (or an explicit baseUrl).
  const clientCfg = { id, baseUrl, apiKey: resolveApiKey(id, cfg.apiKey), options: cfg.options }
  // An explicit `api` wins over the id — that's how a remote Ollama under a custom label still gets the
  // native adapter (and its timing metrics). Absent, the id decides as before.
  if (cfg.api === 'ollama') return new OllamaProvider(clientCfg)
  if (cfg.api === 'openai') return new OpenAIChatProvider(clientCfg)
  if (id === 'ollama') return new OllamaProvider(clientCfg)
  if (id === 'openai') return new OpenAIResponsesProvider(clientCfg)
  return new OpenAIChatProvider(clientCfg)
}
