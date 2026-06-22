// llm/factory.ts — build a ModelProvider from configuration.
//
// The frontend (extension/web/server) reads config (provider id, model, baseUrl, apiKey) and calls
// createProvider(); the result is injected into createSession(). The core depends on the interface,
// the factory owns the "which concrete provider" decision. Add a new provider in ONE place here.

import type { ModelProvider } from './provider'
import { OpenAICompatProvider } from './providers/openaiCompat'

export interface ProviderConfig {
  /** "ollama" | "openai" | "groq" | "openrouter" | "llamacpp" | "anthropic" (more later) */
  provider: string
  model: string
  /** Optional override; falls back to the provider's default origin below. */
  baseUrl?: string
  apiKey?: string
}

// Origins for OpenAI-compatible providers. We append /v1/chat/completions to these.
const OPENAI_COMPAT_BASE_URLS: Record<string, string> = {
  ollama: 'http://127.0.0.1:11434',
  llamacpp: 'http://127.0.0.1:8080',
  openai: 'https://api.openai.com',
  groq: 'https://api.groq.com/openai',
  openrouter: 'https://openrouter.ai/api',
}

export function createProvider(cfg: ProviderConfig): ModelProvider {
  const id = cfg.provider.toLowerCase()

  if (id in OPENAI_COMPAT_BASE_URLS) {
    return new OpenAICompatProvider({
      id,
      baseUrl: cfg.baseUrl || OPENAI_COMPAT_BASE_URLS[id],
      apiKey: cfg.apiKey,
    })
  }

  if (id === 'anthropic') {
    // This provider uses a different wire format (/v1/messages, x-api-key). Its own provider lands
    // when we need it — kept out of the OpenAI-compat path on purpose.
    throw new Error('Provider "anthropic" not implemented yet (needs a dedicated AnthropicProvider).')
  }

  throw new Error(`Unknown provider "${cfg.provider}". Known: ${Object.keys(OPENAI_COMPAT_BASE_URLS).join(', ')}, anthropic.`)
}
