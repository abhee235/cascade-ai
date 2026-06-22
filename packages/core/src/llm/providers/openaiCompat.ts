// llm/providers/openaiCompat.ts — one provider for every OpenAI-compatible backend.
//
// Ollama, OpenAI, Groq, OpenRouter, llama.cpp all speak POST {baseUrl}/v1/chat/completions in the
// OpenAI shape. One implementation, parameterized by baseUrl + apiKey. This file owns the
// internal↔OpenAI translation (ADR-003) — including the tool_use/tool_result ⇄ tool_calls/role:'tool'
// bridge and the streamed tool-call accumulation (the in-app version of scripts/ollama-proxy.ts).

import type { ContentBlock, Message } from '../../protocol'
import type { CompletionRequest, CompletionResult, ModelProvider, StreamEvent } from '../provider'

interface OpenAIToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}
interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
}

const asBlocks = (c: Message['content']): ContentBlock[] =>
  typeof c === 'string' ? [{ type: 'text', text: c }] : c
const textOf = (blocks: ContentBlock[]): string =>
  blocks.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('')

/** Internal content-block messages → OpenAI messages (+ system). Expands tool_use/tool_result. */
function toOpenAIMessages(messages: Message[], system?: string): OpenAIMessage[] {
  const out: OpenAIMessage[] = []
  if (system) out.push({ role: 'system', content: system })
  for (const m of messages) {
    const blocks = asBlocks(m.content)
    if (m.role === 'user') {
      // tool_result blocks become role:'tool' messages keyed by the tool_use id.
      for (const b of blocks) {
        if (b.type === 'tool_result') out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.content })
      }
      const text = textOf(blocks)
      if (text) out.push({ role: 'user', content: text })
    } else {
      const toolUses = blocks.filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
      const msg: OpenAIMessage = { role: 'assistant', content: textOf(blocks) || null }
      if (toolUses.length) {
        msg.tool_calls = toolUses.map((tu) => ({
          id: tu.id,
          type: 'function',
          function: { name: tu.name, arguments: JSON.stringify(tu.input ?? {}) },
        }))
      }
      out.push(msg)
    }
  }
  return out
}

function toOpenAITools(tools: CompletionRequest['tools']) {
  return tools?.length
    ? tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
    : undefined
}

export interface OpenAICompatConfig {
  id: string
  baseUrl: string
  apiKey?: string
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

  private body(req: CompletionRequest, stream: boolean): string {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: toOpenAIMessages(req.messages, req.system),
      stream,
    }
    const tools = toOpenAITools(req.tools)
    if (tools) body.tools = tools
    return JSON.stringify(body)
  }

  async complete(req: CompletionRequest, signal?: AbortSignal): Promise<CompletionResult> {
    const res = await fetch(`${this.cfg.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: this.body(req, false),
      signal,
    })
    if (!res.ok) {
      const b = await res.text().catch(() => '')
      throw new Error(`${this.id} HTTP ${res.status}: ${b.slice(0, 300) || res.statusText}`)
    }
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    return { text: json.choices?.[0]?.message?.content ?? '' }
  }

  async *stream(req: CompletionRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const res = await fetch(`${this.cfg.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: this.body(req, true),
      signal,
    })
    if (!res.ok || !res.body) {
      const b = await res.text().catch(() => '')
      throw new Error(`${this.id} HTTP ${res.status}: ${b.slice(0, 300) || res.statusText}`)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let stopReason: 'end_turn' | 'max_tokens' | 'tool_use' = 'end_turn'
    // Tool calls stream as fragments of a JSON string, keyed by index — accumulate, parse ONCE at end.
    const toolCalls = new Map<number, { id: string; name: string; args: string }>()

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const t = line.trim()
        if (!t.startsWith('data:')) continue
        const data = t.slice(5).trim()
        if (data === '[DONE]') continue
        let chunk: any
        try {
          chunk = JSON.parse(data)
        } catch {
          continue
        }
        const choice = chunk.choices?.[0]
        const delta = choice?.delta
        if (delta?.reasoning) yield { type: 'thinking_delta', thinking: delta.reasoning }
        if (delta?.content) yield { type: 'text_delta', text: delta.content }
        if (Array.isArray(delta?.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx: number = tc.index ?? 0
            const cur = toolCalls.get(idx) ?? { id: '', name: '', args: '' }
            if (tc.id) cur.id = tc.id
            if (tc.function?.name) cur.name += tc.function.name
            if (tc.function?.arguments) cur.args += tc.function.arguments
            toolCalls.set(idx, cur)
          }
        }
        if (choice?.finish_reason === 'length') stopReason = 'max_tokens'
        if (choice?.finish_reason === 'tool_calls') stopReason = 'tool_use'
      }
    }

    // Emit each accumulated tool call as a complete tool_use (parse the JSON args once).
    for (const [idx, c] of toolCalls) {
      let input: unknown = {}
      try {
        input = c.args ? JSON.parse(c.args) : {}
      } catch {
        input = {}
      }
      yield { type: 'tool_use', id: c.id || `call_${idx}`, name: c.name, input }
    }
    yield { type: 'done', stopReason }
  }
}
