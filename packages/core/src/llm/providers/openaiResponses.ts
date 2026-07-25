// llm/providers/openaiResponses.ts — the OpenAI Responses (/v1/responses) wire adapter (ADR-063).
//
// OpenAI's reasoning models (gpt-5.6-luna and up) refuse function tools + reasoning on the legacy
// /v1/chat/completions endpoint. /v1/responses is where OpenAI moved reasoning+tools; its wire shape is
// DIFFERENT: a flat `input` item list (not `messages`), `instructions` for the system prompt, flat tool
// schemas, and function calls carried as `function_call` / `function_call_output` items keyed by `call_id`.
// We stay STATELESS (store:false) and replay Cascade's full history each turn — no server-side session.
//
// It extends OpenAIChatProvider so the NON-streaming calls (complete()/embed() — compaction summaries and
// memory curation, which carry no tools and don't want reasoning overhead) stay on chat/completions. Only
// stream() — the agent loop — is overridden to use Responses.

import type { ContentBlock, Message } from '../../protocol'
import type { CompletionRequest, StreamEvent, TokenUsage } from '../provider'
import { extractProseToolCalls } from '../proseToolCalls'
import { parseToolArgs } from '../jsonRepair'
import { asBlocks, textOf } from './shared'
import { DEFAULT_MAX_OUTPUT_TOKENS, OpenAIChatProvider } from './openaiChat'

type ResponsesItem = Record<string, unknown>

/** Internal content-block messages → Responses `input` items (+ `instructions`). tool_use → function_call,
 *  tool_result → function_call_output (both keyed by our internal id as call_id). Exported for unit testing. */
export function toResponsesInput(messages: Message[], system?: string): { instructions?: string; input: ResponsesItem[] } {
  const input: ResponsesItem[] = []
  // A function_call_output whose function_call isn't in this input is a HARD 400 ("No tool call found for
  // function call output with call_id …") — and because the bad pair lives in the saved history, it replays
  // on EVERY later turn, bricking the chat for good. Histories legitimately lose their head: compaction drops
  // old turns, and an interrupted turn is persisted mid-pair. So pair them up here instead of trusting the
  // history to be well-formed — an unanswerable result is dropped, never sent.
  const emitted = new Set<string>()
  for (const m of messages) {
    const blocks = asBlocks(m.content)
    if (m.role === 'user') {
      // tool results first (a function_call_output must follow its function_call, which the prior
      // assistant turn already emitted), then the user's own text/images.
      for (const b of blocks) if (b.type === 'tool_result' && emitted.has(b.tool_use_id)) input.push({ type: 'function_call_output', call_id: b.tool_use_id, output: b.content ?? '' })
      const text = textOf(blocks)
      const images = blocks.filter((b): b is Extract<ContentBlock, { type: 'image' }> => b.type === 'image')
      if (images.length) {
        const content: Record<string, unknown>[] = []
        if (text) content.push({ type: 'input_text', text })
        for (const img of images) content.push({ type: 'input_image', image_url: img.url })
        input.push({ role: 'user', content })
      } else if (text) {
        input.push({ role: 'user', content: text })
      }
    } else {
      const text = textOf(blocks)
      if (text) input.push({ role: 'assistant', content: [{ type: 'output_text', text }] }) // assistant replay uses output_text
      for (const b of blocks)
        if (b.type === 'tool_use') {
          input.push({ type: 'function_call', call_id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) })
          emitted.add(b.id) // this call is now on the wire — its result may follow
        }
    }
  }
  return { instructions: system, input }
}

/** Responses tool schema is FLAT (name/description/parameters at the top level, not nested under `function`). */
function toResponsesTools(tools: CompletionRequest['tools']) {
  return tools?.length ? tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters })) : undefined
}

export class OpenAIResponsesProvider extends OpenAIChatProvider {
  // OpenAI /v1/responses streaming. Event shapes verified live (gpt-5.6-luna + gpt-5-mini, 2026-07-20):
  // text on `response.output_text.delta`, reasoning summary on `response.reasoning_summary_text.delta`, and
  // COMPLETE tool calls on `response.output_item.done` where item.type==='function_call' (call_id + name +
  // full arguments string — no delta accumulation needed). Usage + truncation land on `response.completed`.
  async *stream(req: CompletionRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const { instructions, input } = toResponsesInput(req.messages, req.system)
    const body: Record<string, unknown> = { model: req.model, input, stream: true, store: false, reasoning: { summary: 'auto' } }
    if (instructions) body.instructions = instructions
    const tools = toResponsesTools(req.tools)
    if (tools) body.tools = tools
    // Responses counts reasoning against the output budget, so max_output_tokens caps reasoning+answer together.
    // ALWAYS capped (wire-parity rule, see wireParity.test.ts): an omitted cap delegates to the backend's
    // default — the exact silent-truncation class that stalled builds on the chat path (ADR-077).
    body.max_output_tokens = req.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
    // NOTE: no `temperature` — reasoning models reject anything but the default (eval determinism is moot here).
    const res = await fetch(`${this.cfg.baseUrl}/v1/responses`, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal })
    if (!res.ok || !res.body) {
      const b = await res.text().catch(() => '')
      throw new Error(`${this.id} HTTP ${res.status}: ${b.slice(0, 300) || res.statusText}`)
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let stopReason: 'end_turn' | 'max_tokens' | 'tool_use' = 'end_turn'
    let usage: TokenUsage | undefined
    let fullText = '' // ADR-047: accumulated for the prose fallback
    let toolCount = 0
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
        let ev: any
        try {
          ev = JSON.parse(data)
        } catch {
          continue
        }
        switch (ev.type) {
          case 'response.output_text.delta':
            if (ev.delta) {
              fullText += ev.delta
              yield { type: 'text_delta', text: ev.delta }
            }
            break
          case 'response.reasoning_summary_text.delta':
            if (ev.delta) yield { type: 'thinking_delta', thinking: ev.delta }
            break
          case 'response.output_item.done':
            if (ev.item?.type === 'function_call') {
              toolCount++
              stopReason = 'tool_use'
              // arguments is a complete JSON string here; parseToolArgs repairs almost-JSON + carries the
              // unrepairable through honestly (item 4a), same contract as the chat path.
              const parsed = parseToolArgs(ev.item.arguments)
              yield { type: 'tool_use', id: ev.item.call_id || ev.item.id || `call_${toolCount}`, name: ev.item.name ?? '', input: parsed.input, ...(parsed.via === 'repaired' ? { repaired: true } : {}) }
            }
            break
          case 'response.completed':
          case 'response.incomplete': {
            const r = ev.response
            if (r?.usage) usage = { inputTokens: r.usage.input_tokens, outputTokens: r.usage.output_tokens }
            if (r?.incomplete_details?.reason === 'max_output_tokens') stopReason = 'max_tokens'
            break
          }
          case 'response.failed':
          case 'error':
            throw new Error(`${this.id} responses error: ${ev.response?.error?.message ?? ev.message ?? 'stream failed'}`)
        }
      }
    }
    // ADR-047: prose fallback parity — rarely needed on a hosted reasoning model, but keep the contract.
    if (toolCount === 0 && req.tools?.length) {
      const prose = extractProseToolCalls(fullText, req.tools.map((t) => t.name))
      if (prose.length > 0) {
        stopReason = 'tool_use'
        yield { type: 'tool_use', id: 'prose_0', name: prose[0].name, input: prose[0].input }
      }
    }
    yield { type: 'done', stopReason, usage }
  }
}
