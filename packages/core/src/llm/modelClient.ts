// llm/modelClient.ts — the boundary between Cascade's internal world and the model provider.
//
// The model call (streaming and not), and the
// format translation that scripts/ollama-proxy.ts does — except here it lives INSIDE the app.
//
// Golden Rule (ADR-003): Cascade speaks an content-block internal message model everywhere; the
// ONLY place we translate to the provider's OpenAI shape is here. Phase 1 is non-streaming.

import type { Message } from '../protocol'

export interface ModelOptions {
  baseUrl: string
  model: string
  signal?: AbortSignal
}

// OpenAI chat message shape (what Ollama's /v1/chat/completions expects).
interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
}

/** Flatten an internal message's content blocks to plain text (Phase 1 only handles text). */
function blocksToText(content: Message['content']): string {
  if (typeof content === 'string') return content
  return content.map((b) => (b.type === 'text' ? b.text : '')).join('')
}

/** Translate internal content-block messages → OpenAI messages. The one translation point. */
export function toProviderMessages(messages: Message[]): OpenAIMessage[] {
  return messages.map((m) => ({ role: m.role, content: blocksToText(m.content) }))
}

/**
 * Phase 1: one non-streaming chat completion. Returns the assistant's reply text.
 * Throws on transport/HTTP errors so the caller can surface them (never fail silently).
 */
export async function callOllama(messages: Message[], opts: ModelOptions): Promise<string> {
  const res = await fetch(`${opts.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: opts.model,
      messages: toProviderMessages(messages),
      stream: false,
    }),
    signal: opts.signal,
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Ollama HTTP ${res.status}: ${body.slice(0, 300) || res.statusText}`)
  }

  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[]
  }
  return json.choices?.[0]?.message?.content ?? ''
}
