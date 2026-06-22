// llm/providers/openaiCompat.ts — one provider for every OpenAI-compatible backend.
//
// Ollama, OpenAI, Groq, OpenRouter, and llama.cpp all speak POST {baseUrl}/v1/chat/completions in the
// OpenAI shape. So they share ONE implementation, parameterized by baseUrl + apiKey. Only Anthropic
// (different wire format) needs its own provider later.
//
// This file owns the internal→OpenAI message translation (ADR-003: translate only at the boundary).

import type { Message } from '../../protocol'
import type { CompletionRequest, CompletionResult, ModelProvider, StreamEvent } from '../provider'

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

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.cfg.apiKey) h.Authorization = `Bearer ${this.cfg.apiKey}`
    return h
  }

  async complete(req: CompletionRequest, signal?: AbortSignal): Promise<CompletionResult> {
    const res = await fetch(`${this.cfg.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ model: req.model, messages: toOpenAIMessages(req.messages), stream: false }),
      signal,
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`${this.id} HTTP ${res.status}: ${body.slice(0, 300) || res.statusText}`)
    }
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    return { text: json.choices?.[0]?.message?.content ?? '' }
  }

  async *stream(req: CompletionRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const res = await fetch(`${this.cfg.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ model: req.model, messages: toOpenAIMessages(req.messages), stream: true }),
      signal,
    })
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => '')
      throw new Error(`${this.id} HTTP ${res.status}: ${body.slice(0, 300) || res.statusText}`)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = '' // holds the partial trailing line between chunks
    let stopReason: 'end_turn' | 'max_tokens' = 'end_turn'

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? '' // last item may be an incomplete line — keep it for next chunk

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const data = trimmed.slice(5).trim()
        if (data === '[DONE]') continue
        let chunk: any
        try {
          chunk = JSON.parse(data)
        } catch {
          continue // partial/non-JSON keepalive — skip
        }
        const choice = chunk.choices?.[0]
        const delta = choice?.delta
        // Order matters: reasoning arrives before content for thinking models.
        if (delta?.reasoning) yield { type: 'thinking_delta', thinking: delta.reasoning }
        if (delta?.content) yield { type: 'text_delta', text: delta.content }
        if (choice?.finish_reason === 'length') stopReason = 'max_tokens'
      }
    }
    yield { type: 'done', stopReason }
  }
}
