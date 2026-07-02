// llm/providers/openaiCompat.ts — one provider for every OpenAI-compatible backend.
//
// Ollama, OpenAI, Groq, OpenRouter, llama.cpp all speak POST {baseUrl}/v1/chat/completions in the
// OpenAI shape. One implementation, parameterized by baseUrl + apiKey. This file owns the
// internal↔OpenAI translation (ADR-003) — including the tool_use/tool_result ⇄ tool_calls/role:'tool'
// bridge and the streamed tool-call accumulation (the in-app version of scripts/ollama-proxy.ts).

import type { ContentBlock, Message } from '../../protocol'
import type { CompletionRequest, CompletionResult, ModelProvider, StreamEvent, TokenUsage } from '../provider'

interface OpenAIToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}
// Content can be a plain string or, for a multimodal user turn (M11), an array of text/image parts (the
// OpenAI-compatible vision shape that Ollama vision models accept).
type OpenAIContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | OpenAIContentPart[] | null
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
}

const asBlocks = (c: Message['content']): ContentBlock[] =>
  typeof c === 'string' ? [{ type: 'text', text: c }] : c
const textOf = (blocks: ContentBlock[]): string =>
  blocks.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('')

/** Internal content-block messages → OpenAI messages (+ system). Expands tool_use/tool_result.
 *  Exported for unit testing (the bridge is the trickiest translation). */
export function toOpenAIMessages(messages: Message[], system?: string): OpenAIMessage[] {
  const out: OpenAIMessage[] = []
  if (system) out.push({ role: 'system', content: system })
  for (const m of messages) {
    const blocks = asBlocks(m.content)
    if (m.role === 'user') {
      // tool_result blocks become role:'tool' messages keyed by the tool_use id.
      for (const b of blocks) {
        if (b.type === 'tool_result') out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.content ?? '' })
      }
      const text = textOf(blocks)
      const images = blocks.filter((b): b is Extract<ContentBlock, { type: 'image' }> => b.type === 'image')
      if (images.length) {
        // Multimodal: send text + image parts (vision models accept data-URI image_url).
        const parts: OpenAIContentPart[] = []
        if (text) parts.push({ type: 'text', text })
        for (const img of images) parts.push({ type: 'image_url', image_url: { url: img.url } })
        out.push({ role: 'user', content: parts })
      } else if (text) {
        out.push({ role: 'user', content: text })
      }
    } else {
      const toolUses = blocks.filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
      // Use '' (not null) for a tool-call message with no text: the OpenAI spec allows null content here,
      // but Ollama (>=0.30.x) rejects it with HTTP 400 "invalid message content type: <nil>".
      const msg: OpenAIMessage = { role: 'assistant', content: textOf(blocks) }
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

/** Parse Ollama's `/api/show` `parameters` blob (newline-delimited "name    value" lines) into the model's
 *  ALLOCATED limits (ADR-038). `num_ctx` is what Ollama actually runs the model at (the Modelfile pin), NOT the
 *  arch `context_length` (the trained ceiling). `num_predict` ≤ 0 means "unbounded" → not a useful cap. Pure +
 *  exported for testing. */
export function parseOllamaLimits(parameters: string | undefined): { contextWindow?: number; maxOutputTokens?: number } {
  const intParam = (name: string): number | undefined => {
    const m = (parameters ?? '').match(new RegExp(`^\\s*${name}\\s+(-?\\d+)`, 'm'))
    return m ? Number.parseInt(m[1], 10) : undefined
  }
  const numCtx = intParam('num_ctx')
  const numPredict = intParam('num_predict')
  return {
    contextWindow: numCtx && numCtx > 0 ? numCtx : undefined,
    maxOutputTokens: numPredict && numPredict > 0 ? numPredict : undefined,
  }
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
    // E1/ADR-040: ask for token usage on the final stream chunk (OpenAI spec; Ollama supports it too).
    // Backends that don't know the field ignore it — usage just stays undefined.
    if (stream) body.stream_options = { include_usage: true }
    if (req.temperature !== undefined) body.temperature = req.temperature // eval determinism (temperature 0)
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

  async embed(texts: string[], model: string, signal?: AbortSignal): Promise<number[][]> {
    const res = await fetch(`${this.cfg.baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ model, input: texts }),
      signal,
    })
    if (!res.ok) {
      const b = await res.text().catch(() => '')
      throw new Error(`${this.id} embeddings HTTP ${res.status}: ${b.slice(0, 200) || res.statusText}`)
    }
    const json = (await res.json()) as { data?: { embedding: number[] }[] }
    return (json.data ?? []).map((d) => d.embedding)
  }

  /** ADR-038: read the model's allocated limits from Ollama's /api/show (Modelfile num_ctx/num_predict). This is
   *  the FIX for the static-map mis-sizing bug (coding-qwen36 matched the generic qwen36→32k rule but actually
   *  runs at 128k). Best-effort: a non-Ollama backend 404s → {} → the session falls back to the model map. */
  async detectModelLimits(model: string, signal?: AbortSignal): Promise<{ contextWindow?: number; maxOutputTokens?: number }> {
    try {
      const res = await fetch(`${this.cfg.baseUrl}/api/show`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ model }),
        signal,
      })
      if (!res.ok) return {}
      const json = (await res.json()) as { parameters?: string }
      return parseOllamaLimits(json.parameters)
    } catch {
      return {} // network error / not Ollama / aborted — the caller keeps its fallback window
    }
  }

  async *stream(req: CompletionRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    // M11: image turns go through Ollama's NATIVE /api/chat — its OpenAI-compat /v1 endpoint silently drops
    // image_url (verified on Ollama 0.30.10), whereas /api/chat accepts an `images:[base64]` array per message.
    if (req.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'image'))) {
      yield* this.streamNative(req, signal)
      return
    }
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
    let usage: TokenUsage | undefined // E1: filled by the final chunk when stream_options.include_usage is honoured
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
        // E1/ADR-040: with include_usage the LAST chunk carries usage (typically with an empty choices array).
        if (chunk.usage) {
          usage = { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens }
        }
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
    yield { type: 'done', stopReason, usage }
  }

  // M11: Ollama-native streaming (/api/chat) for multimodal turns. NDJSON, one JSON object per line; each
  // carries `message.content` (+ optional `thinking`/`tool_calls`) and the last one has `done:true`. Tool
  // calls arrive whole here (arguments already an object), so we emit them directly.
  private async *streamNative(req: CompletionRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const body = JSON.stringify({ model: req.model, messages: toNativeMessages(req.messages, req.system), tools: toOpenAITools(req.tools), stream: true })
    const res = await fetch(`${this.cfg.baseUrl}/api/chat`, { method: 'POST', headers: this.headers(), body, signal })
    if (!res.ok || !res.body) {
      const b = await res.text().catch(() => '')
      throw new Error(`${this.id} HTTP ${res.status}: ${b.slice(0, 300) || res.statusText}`)
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let stopReason: 'end_turn' | 'max_tokens' | 'tool_use' = 'end_turn'
    let usage: TokenUsage | undefined // E1: the final done:true object carries prompt_eval_count/eval_count
    let toolIdx = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const t = line.trim()
        if (!t) continue
        let obj: any
        try {
          obj = JSON.parse(t)
        } catch {
          continue
        }
        const m = obj.message
        if (m?.thinking) yield { type: 'thinking_delta', thinking: m.thinking }
        if (m?.content) yield { type: 'text_delta', text: m.content }
        if (Array.isArray(m?.tool_calls)) {
          for (const tc of m.tool_calls) {
            stopReason = 'tool_use'
            yield { type: 'tool_use', id: tc.id || `call_${toolIdx++}`, name: tc.function?.name ?? '', input: tc.function?.arguments ?? {} }
          }
        }
        if (obj.done) {
          if (obj.done_reason === 'length') stopReason = 'max_tokens'
          if (obj.prompt_eval_count !== undefined || obj.eval_count !== undefined) {
            usage = { inputTokens: obj.prompt_eval_count, outputTokens: obj.eval_count }
          }
        }
      }
    }
    yield { type: 'done', stopReason, usage }
  }
}

// Internal messages → Ollama NATIVE /api/chat messages. Like the OpenAI mapping, but images attach as a
// `images:[base64]` array on the user message (data-URI prefix stripped) and tool-call arguments stay objects.
function toNativeMessages(messages: Message[], system?: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  if (system) out.push({ role: 'system', content: system })
  for (const m of messages) {
    const blocks = asBlocks(m.content)
    if (m.role === 'user') {
      for (const b of blocks) if (b.type === 'tool_result') out.push({ role: 'tool', content: b.content ?? '' })
      const text = textOf(blocks)
      const images = blocks.filter((b): b is Extract<ContentBlock, { type: 'image' }> => b.type === 'image').map((b) => b.url.replace(/^data:[^;]+;base64,/, ''))
      if (text || images.length) out.push(images.length ? { role: 'user', content: text, images } : { role: 'user', content: text })
    } else {
      const toolUses = blocks.filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
      const msg: Record<string, unknown> = { role: 'assistant', content: textOf(blocks) }
      if (toolUses.length) msg.tool_calls = toolUses.map((tu) => ({ function: { name: tu.name, arguments: tu.input ?? {} } }))
      out.push(msg)
    }
  }
  return out
}
