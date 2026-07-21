// llm/providers/ollama.ts — the Ollama adapter: chat/completions for the common path, plus everything
// that's genuinely Ollama-native and lives NOWHERE else.
//
// Extends OpenAIChatProvider (Ollama speaks /v1/chat/completions too) and overrides stream() to route
// through the NATIVE /api/chat when the request needs something /v1 can't express:
//   - a pinned context window (options.num_ctx — ADR-038; /v1 silently front-truncates instead),
//   - static load options (num_gpu etc.),
//   - image turns (Ollama's /v1 drops image_url; /api/chat takes an `images:[base64]` array).
// It also owns the Ollama-only capability methods: detectModelLimits (/api/show), recover (keep_alive:0
// recycle), and alive (/api/tags liveness for the stall watchdog). Hosted backends simply don't have
// these — so they're here, not on the base, and the callers already treat them as optional.

import type { ContentBlock, Message } from '../../protocol'
import type { CompletionRequest, StreamEvent, TokenUsage } from '../provider'
import { extractProseToolCalls } from '../proseToolCalls'
import { parseToolArgs } from '../jsonRepair'
import { asBlocks, textOf } from './shared'
import { OpenAIChatProvider, toOpenAITools } from './openaiChat'

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

export class OllamaProvider extends OpenAIChatProvider {
  async *stream(req: CompletionRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    // ADR-038 ENFORCEMENT: /v1 cannot express num_ctx — when the caller pins a window, route native so
    // options.num_ctx goes on the wire (else Ollama silently front-truncates the prompt). Static load
    // options and image turns likewise can only be expressed on /api/chat.
    const enforceWindow = req.contextWindow !== undefined
    const hasStaticOptions = !!this.cfg.options && Object.keys(this.cfg.options).length > 0
    const hasImages = req.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'image'))
    if (enforceWindow || hasStaticOptions || hasImages) {
      yield* this.streamNative(req, signal)
      return
    }
    yield* super.stream(req, signal) // the plain /v1/chat/completions path (inherited)
  }

  /** ADR-038: read the model's allocated limits from Ollama's /api/show (Modelfile num_ctx/num_predict).
   *  This is the FIX for the static-map mis-sizing bug (coding-qwen36 matched the generic qwen36→32k rule but
   *  actually runs at 128k). Best-effort: any failure → {} → the session falls back to the model map. */
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
      return {} // network error / aborted — the caller keeps its fallback window
    }
  }

  /** ADR-061: liveness probe for the stall watchdog. /api/tags is served by the Ollama HTTP layer and
   *  answers even while a generation is running — so `true` during pre-first-token silence means "busy
   *  prefilling", not "dead". Bounded and never throws. */
  async alive(signal?: AbortSignal): Promise<boolean> {
    try {
      const res = await fetch(`${this.cfg.baseUrl}/api/tags`, { headers: this.headers(), signal: signal ?? AbortSignal.timeout(5000) })
      return res.ok
    } catch {
      return false
    }
  }

  /** WATCHDOG (resilience.recover): recycle a degraded local model — unload via keep_alive:0, then a 1-token
   *  generate forces a FRESH load. Measured remedy across six live Ollama crashes: a crashed runner answers
   *  again but degraded (empty replies) until this exact sequence. Best-effort. */
  async recover(model: string): Promise<void> {
    try {
      await fetch(`${this.cfg.baseUrl}/api/generate`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ model, keep_alive: 0 }),
        signal: AbortSignal.timeout(15_000),
      })
      await fetch(`${this.cfg.baseUrl}/api/generate`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ model, prompt: 'ok', stream: false, options: { num_predict: 1 } }),
        signal: AbortSignal.timeout(120_000), // cold load can take a while
      })
    } catch {
      /* best-effort — the retry proceeds regardless */
    }
  }

  // M11: Ollama-native streaming (/api/chat). NDJSON, one JSON object per line; each carries `message.content`
  // (+ optional `thinking`/`tool_calls`) and the last one has `done:true`. Tool calls arrive whole here
  // (arguments already an object), so we emit them directly.
  private async *streamNative(req: CompletionRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const options: Record<string, unknown> = { ...this.cfg.options } // static adapter config first (num_gpu etc.)
    if (req.contextWindow !== undefined) options.num_ctx = req.contextWindow // ADR-038: enforce the allocated window
    if (req.maxOutputTokens !== undefined) options.num_predict = req.maxOutputTokens
    if (req.temperature !== undefined) options.temperature = req.temperature
    const body = JSON.stringify({ model: req.model, messages: toNativeMessages(req.messages, req.system), tools: toOpenAITools(req.tools), stream: true, ...(Object.keys(options).length ? { options } : {}) })
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
    let fullText = '' // ADR-047: accumulated for the prose fallback
    let toolIdx = 0
    let nativeCalls = 0
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
        if (m?.content) {
          fullText += m.content
          yield { type: 'text_delta', text: m.content }
        }
        if (Array.isArray(m?.tool_calls)) {
          for (const tc of m.tool_calls) {
            stopReason = 'tool_use'
            nativeCalls++
            // Usually an object already; some model templates deliver a STRING (occasionally malformed) —
            // parseToolArgs repairs or carries it honestly (item 4a).
            const parsed = parseToolArgs(tc.function?.arguments)
            yield { type: 'tool_use', id: tc.id || `call_${toolIdx++}`, name: tc.function?.name ?? '', input: parsed.input, ...(parsed.via === 'repaired' ? { repaired: true } : {}) }
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
    // ADR-047: same prose fallback as the /v1 path (see OpenAIChatProvider.stream for the rationale).
    if (nativeCalls === 0 && req.tools?.length) {
      const prose = extractProseToolCalls(fullText, req.tools.map((t) => t.name))
      if (prose.length > 0) {
        stopReason = 'tool_use'
        yield { type: 'tool_use', id: 'prose_0', name: prose[0].name, input: prose[0].input }
      }
    }
    yield { type: 'done', stopReason, usage }
  }
}
