// llm/providers/openaiCompat.ts — one provider for every OpenAI-compatible backend.
//
// Ollama, OpenAI, Groq, OpenRouter, and llama.cpp all speak POST {baseUrl}/v1/chat/completions in the
// OpenAI shape. So they share ONE implementation, parameterized by baseUrl + apiKey. Only Anthropic
// (different wire format) needs its own provider later.
//
// This file owns the internal→OpenAI message translation (ADR-003: translate only at the boundary).

import type { Message } from '../../protocol'
import type { CompletionRequest, CompletionResult, ModelProvider } from '../provider'

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
}

/** Flatten internal content blocks to text (Phase 1 only handles text blocks). */
function blocksToText(content: Message['content']): string {
  if (typeof content === 'string') return content
  return content.map((b) => (b.type === 'text' ? b.text : '')).join('')
}

/** Internal content-block messages → OpenAI messages. The single translation point. */
function toOpenAIMessages(messages: Message[]): OpenAIMessage[] {
  return messages.map((m) => ({ role: m.role, content: blocksToText(m.content) }))
}

export interface OpenAICompatConfig {
  id: string // "ollama", "openai", "groq", ...
  baseUrl: string // origin only; we append /v1/chat/completions
  apiKey?: string // omitted for local Ollama / llama.cpp
}

export class OpenAICompatProvider implements ModelProvider {
  readonly id: string
  constructor(private readonly cfg: OpenAICompatConfig) {
    this.id = cfg.id
  }

  async complete(req: CompletionRequest, signal?: AbortSignal): Promise<CompletionResult> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.cfg.apiKey) headers.Authorization = `Bearer ${this.cfg.apiKey}`

    const res = await fetch(`${this.cfg.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: req.model,
        messages: toOpenAIMessages(req.messages),
        stream: false,
      }),
      signal,
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`${this.id} HTTP ${res.status}: ${body.slice(0, 300) || res.statusText}`)
    }

    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    return { text: json.choices?.[0]?.message?.content ?? '' }
  }
}
