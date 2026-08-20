// llm/providers/openaiChat.ts — the OpenAI chat/completions wire adapter, and the BASE for the family.
//
// POST {baseUrl}/v1/chat/completions in the OpenAI shape covers most backends: NVIDIA NIM, Groq,
// OpenRouter, llama.cpp, any OpenAI-compatible endpoint — and Ollama's /v1 path. This file owns that
// wire translation (ADR-003): the tool_use/tool_result ⇄ tool_calls/role:'tool' bridge, streamed
// tool-call accumulation, and the two learned quirks (reasoning+tools, single-tool templates).
//
// It is also the base class. OllamaProvider and OpenAIResponsesProvider EXTEND it and override only
// stream() — they inherit complete()/embed()/postChat()/body() unchanged. Split by WIRE FORMAT, not by
// vendor: vendors that share this format share this file; a genuinely different API (Responses, Ollama
// native, Gemini) gets its own file. — ADR-065.

import type { ContentBlock, Message } from '../../protocol'
import type { CompletionRequest, CompletionResult, ModelProvider, StreamEvent, TokenUsage } from '../provider'
import { extractProseToolCalls } from '../proseToolCalls'
import { parseToolArgs } from '../jsonRepair'
import { asBlocks, textOf } from './shared'

/** The builtin hosted gateways (mirrors modelSpecs.HOSTED_PROVIDERS): sampler extensions beyond
 *  temperature/top_p/presence_penalty are rejected there with HTTP 400, so they are never sent. */
const HOSTED_PROVIDER_IDS = new Set(['openai', 'groq', 'openrouter', 'nvidia'])

/** Output cap sent when the caller pins none. Generous enough never to clip a real answer, but present so a
 *  BACKEND's own (sometimes tiny) default can't silently truncate turns — see body(). Shared with the native
 *  Ollama adapter so the two wire paths can't drift apart. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16384

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

/** Internal content-block messages → OpenAI messages (+ system). Expands tool_use/tool_result.
 *  `singleToolCall` (learned when a backend 500s on parallel calls — see forceSingleTool): keep only the
 *  FIRST tool_call of each assistant turn and DROP the now-orphaned tool_results, so an already-recorded
 *  parallel-call turn can still be replayed to a template that rejects multi-call messages.
 *  Exported for unit testing (the bridge is the trickiest translation). */
export function toOpenAIMessages(messages: Message[], system?: string, opts?: { singleToolCall?: boolean }): OpenAIMessage[] {
  const out: OpenAIMessage[] = []
  const droppedToolIds = new Set<string>() // tool_use ids trimmed by singleToolCall — their results must go too
  if (system) out.push({ role: 'system', content: system })
  for (const m of messages) {
    const blocks = asBlocks(m.content)
    if (m.role === 'user') {
      // tool_result blocks become role:'tool' messages keyed by the tool_use id (skip results whose call
      // was trimmed above — an orphan tool_call_id would itself be a wire error).
      for (const b of blocks) {
        if (b.type === 'tool_result' && !droppedToolIds.has(b.tool_use_id)) out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.content ?? '' })
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
      let toolUses = blocks.filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
      if (opts?.singleToolCall && toolUses.length > 1) {
        for (const extra of toolUses.slice(1)) droppedToolIds.add(extra.id)
        toolUses = toolUses.slice(0, 1)
      }
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

/** Internal tool schemas → OpenAI's nested `{type:'function', function:{…}}` shape. Also used by the Ollama
 *  native path (its /api/chat accepts the same tool shape). */
export function toOpenAITools(tools: CompletionRequest['tools']) {
  return tools?.length
    ? tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
    : undefined
}

export interface OpenAICompatConfig {
  id: string
  baseUrl: string
  apiKey?: string
  /** Backend-native runtime options merged VERBATIM into Ollama's /api/chat `options` (e.g. `num_gpu` to
   *  trade offloaded layers for VRAM headroom). Request-derived options (num_ctx/num_predict/temperature)
   *  win on conflict — a pinned window must never be overridden by static config. Ignored on /v1 backends. */
  options?: Record<string, unknown>
}

export class OpenAIChatProvider implements ModelProvider {
  readonly id: string
  // OpenAI's newer reasoning models (gpt-5.6-luna and up) reject function tools on /v1/chat/completions
  // UNLESS reasoning is off ("set reasoning_effort to 'none'"). We can't know which models per model id
  // without asking, and older ones (gpt-5-mini) accept tools WITH reasoning — so we LEARN it: the first
  // request that hits that exact 400 is retried with reasoning_effort:'none', and the model is remembered
  // so later turns skip the doomed first attempt. Inert for every model/backend that doesn't emit the error.
  // (For OpenAI itself, the agent loop uses OpenAIResponsesProvider — which keeps reasoning AND tools.)
  private readonly forceReasoningNone = new Set<string>()
  private static readonly REASONING_TOOLS_400 = /reasoning_effort.*not supported|reasoning_effort to 'none'/i
  // Some hosted tool templates (NIM llama-3.1-8b, measured 2026-07-21) 500 when an assistant turn carries
  // more than one tool_call — and `parallel_tool_calls:false` does NOT stop the model emitting them, so the
  // poison turn reaches history and wedges every later replay. Learned per model on that exact 500: collapse
  // history to one call at the wire (toOpenAIMessages) AND emit only the first tool_use per turn (below).
  private readonly forceSingleTool = new Set<string>()
  private static readonly SINGLE_TOOL_500 = /only supports single tool-calls/i
  // TASK-thinking-control learned quirks: strict validators reject the knob fields as unknown params.
  // Degrade once on the specific 400 and remember — kwargs first (rarer support), then the knob entirely.
  private readonly noTemplateKwargs = new Set<string>()
  private readonly noThinkingParam = new Set<string>()
  private static readonly UNKNOWN_PARAM_400 = /unrecognized|unknown|unexpected|extra (field|inputs|forbidden)|not (a )?permitted|invalid parameter/i

  // `cfg` and `headers()` are protected so the subclass adapters (Ollama native, OpenAI Responses) can
  // build their own requests against the same base URL + auth.
  constructor(protected readonly cfg: OpenAICompatConfig) {
    this.id = cfg.id
  }

  protected headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    // A key that ALREADY names its auth scheme is passed through verbatim. Measured (2026-07-24): a rented
    // Vast.ai GPU fronts its Ollama port with Caddy demanding HTTP **Basic** auth (`WWW-Authenticate: Basic`),
    // while everything else in this family wants Bearer — and Node's fetch REFUSES a `user:pass@host` URL
    // ("Request cannot be constructed from a URL that includes credentials"), so the URL trick can't work.
    // Accepting a full scheme here lets any such endpoint be configured with no protocol/UI change:
    // paste `Basic <base64(user:pass)>` as the API key. A bare key still gets the usual `Bearer` prefix.
    if (this.cfg.apiKey) h.Authorization = /^(Basic|Bearer) /i.test(this.cfg.apiKey) ? this.cfg.apiKey : `Bearer ${this.cfg.apiKey}`
    return h
  }

  private body(req: CompletionRequest, stream: boolean): string {
    // Mirrors modelSpecs.HOSTED_PROVIDERS — the gateways where sampler extensions 400.

    const singleToolCall = this.forceSingleTool.has(req.model)
    const body: Record<string, unknown> = {
      model: req.model,
      messages: toOpenAIMessages(req.messages, req.system, { singleToolCall }),
      stream,
    }
    // E1/ADR-040: ask for token usage on the final stream chunk (OpenAI spec; Ollama supports it too).
    // Backends that don't know the field ignore it — usage just stays undefined.
    if (stream) body.stream_options = { include_usage: true }
    if (req.temperature !== undefined) body.temperature = req.temperature // eval determinism (temperature 0)
    if (req.topP !== undefined) body.top_p = req.topP // ADR-067 per-model sampling
    // presence_penalty is STANDARD OpenAI — every compat backend accepts it, so it always flows. It is
    // also the anti-loop lever Qwen recommends (~1.5) for quantized builds, which is exactly what a
    // self-hosted vLLM/llama.cpp endpoint tends to be serving.
    if (req.presencePenalty !== undefined) body.presence_penalty = req.presencePenalty
    // top_k / repetition_penalty are EXTENSIONS: vLLM, SGLang, llama.cpp server and LM Studio all honor
    // them on their OpenAI-compat routes, while the builtin hosted gateways reject unknown params with a
    // 400. Sent only to endpoints we know are self-hosted (custom provider ids — the ADR-076 path).
    if (!HOSTED_PROVIDER_IDS.has(this.cfg.id)) {
      if (req.topK !== undefined) body.top_k = req.topK
      if (req.repeatPenalty !== undefined) body.repetition_penalty = req.repeatPenalty
    }
    {
      // ADR-038: output cap on the wire. OpenAI RENAMED the field: current models (gpt-5.x, o-series)
      // reject `max_tokens` with HTTP 400 and require `max_completion_tokens` (older gpt-4o accepts both).
      // Every other compat backend (Ollama, NVIDIA NIM, OpenRouter, Groq…) only knows `max_tokens`.
      //
      // ALWAYS send a cap (never omit max_tokens). Omitting it hands the decision to
      // the BACKEND's default, which can be tiny: measured 2026-07-25 against a rented Ollama `/v1` endpoint
      // configured without maxOutputTokens — turns came back `finish_reason:"length"` after as few as 38 output
      // tokens, so the loop's max-tokens gate fired 6× and the build stalled mid-answer with empty responses.
      // An explicit generous default makes truncation mean what it says instead of tracking a backend quirk.
      let cap = req.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
      // CLAMP to the room the window actually has. Strict servers (vLLM foremost) reject any request where
      // input + max_tokens exceeds max_model_len — measured killing a turn dead: a 24,577-token prompt plus
      // our fixed 16,384 cap totalled 40,961 against a 40,960 window, HTTP 400, and every retry identical
      // (the failure sat in the gap where the prompt is too big for the cap but too small to trigger
      // compaction). Ollama never rejects, which is why a fixed cap survived until a strict server met it.
      //
      // The estimate divides by 3.3 chars/token rather than the usual 4 and adds a fixed guard — BOTH
      // biases deliberately overestimate the input so the clamp errs toward asking for less output, never
      // toward another 400. The floor keeps degenerate room from producing a useless 50-token budget; if
      // even the floor does not fit, the request was doomed regardless and compaction is the real fix.
      if (req.contextWindow) {
        // 3.0 chars/token, not the usual 4: agent prompts are token-DENSE (code, JSON, punctuation), and
        // the first version of this clamp used 3.3 — which under-counted a real 24,577-token prompt by
        // ~1,400 tokens, computed room just above the cap, stood down, and the 400 sailed through anyway.
        const estInputTokens = Math.ceil(JSON.stringify(body.messages).length / 3.0) + 800
        const room = req.contextWindow - estInputTokens
        if (room < cap) cap = Math.max(1024, room)
      }
      if (this.cfg.id === 'openai') body.max_completion_tokens = cap
      else body.max_tokens = cap
    }
    // TASK-thinking-control: the user's reasoning-effort knob. `reasoning_effort` is the closest thing the
    // chat wire has to a standard (OpenAI, vLLM — Hetzner honors it, measured 2026-08-19 — OpenRouter);
    // self-hosted template-driven backends (llama-server, vLLM) additionally take chat_template_kwargs,
    // which the Qwen3.8 template reads (enable_thinking / reasoning_effort — it aliases level names). Both
    // ride the learned-quirk degrade in postChat: a backend that 400s the knob loses it, never the turn.
    if (req.thinking !== undefined && !this.noThinkingParam.has(req.model)) {
      body.reasoning_effort = req.thinking === 'off' ? 'none' : req.thinking
      if (!HOSTED_PROVIDER_IDS.has(this.cfg.id) && !this.noTemplateKwargs.has(req.model)) {
        body.chat_template_kwargs = req.thinking === 'off' ? { enable_thinking: false } : { reasoning_effort: req.thinking }
      }
    }
    // Learned (see forceReasoningNone): this model needs reasoning OFF to accept tools on this endpoint.
    if (this.forceReasoningNone.has(req.model)) body.reasoning_effort = 'none'
    const tools = toOpenAITools(req.tools)
    if (tools) {
      body.tools = tools
      // Learned models (forceSingleTool): ask for one call per turn. It's a HINT — NIM llama-3.1-8b ignores
      // it at generation time (measured), which is why the real guarantee is the emission cap in stream()
      // plus the history collapse above; this just reduces wasted multi-call generations where honored.
      if (singleToolCall) body.parallel_tool_calls = false
    }
    return JSON.stringify(body)
  }

  /** POST to /v1/chat/completions with ONE adaptive retry per learnable quirk. The request is rejected at
   *  validation (before any stream bytes), so re-issuing is clean for both complete + stream:
   *   - reasoning+tools 400 → remember the model, re-issue with reasoning_effort:'none' (ADR-063 stopgap).
   *   - "single tool-calls" 500 → remember the model; the re-issue's body() now collapses multi-call history. */
  private async postChat(req: CompletionRequest, stream: boolean, signal?: AbortSignal): Promise<Response> {
    const url = `${this.cfg.baseUrl}/v1/chat/completions`
    const send = () => fetch(url, { method: 'POST', headers: this.headers(), body: this.body(req, stream), signal })
    let res = await send()
    // TASK-thinking-control degrade — checked FIRST and allowed to chain into the retries below, because a
    // strict validator reports one unknown field per response: drop chat_template_kwargs, then the knob.
    if (res.status === 400 && req.thinking !== undefined && !this.noThinkingParam.has(req.model)) {
      let b = await res.clone().text().catch(() => '')
      if (/chat_template_kwargs/i.test(b)) {
        this.noTemplateKwargs.add(req.model)
        res = await send()
        if (res.status === 400) b = await res.clone().text().catch(() => '') // the retry may name the NEXT unknown field
      }
      if (res.status === 400 && /reasoning_effort/i.test(b) && OpenAIChatProvider.UNKNOWN_PARAM_400.test(b)) {
        this.noThinkingParam.add(req.model)
        res = await send()
      }
    }
    if (!res.ok && req.tools?.length) {
      const b = await res.clone().text().catch(() => '') // clone so the caller's error path can still read it
      if (res.status === 400 && !this.forceReasoningNone.has(req.model) && OpenAIChatProvider.REASONING_TOOLS_400.test(b)) {
        this.forceReasoningNone.add(req.model)
        return send()
      }
      if (res.status >= 400 && !this.forceSingleTool.has(req.model) && OpenAIChatProvider.SINGLE_TOOL_500.test(b)) {
        this.forceSingleTool.add(req.model)
        return send()
      }
    }
    return res
  }

  /** ADR-061 liveness for HOSTED/OpenAI-compat endpoints (was Ollama-only): "is the backend up while the
   *  chat stream is silent?" — measured against Hetzner's free tier, where /v1/models answers in 0.5s while
   *  a chat request queues for minutes. With this, the pre-first-token watchdog waits out a deep queue
   *  (up to firstEventMaxMs) instead of aborting at stallTimeoutMs and re-queueing at the BACK — each such
   *  retry also burned rate-limit budget. Mid-stream stalls are unaffected (never extended). */
  async alive(signal?: AbortSignal): Promise<boolean> {
    try {
      const timeout = AbortSignal.timeout(10_000)
      const res = await fetch(`${this.cfg.baseUrl}/v1/models`, { headers: this.headers(), signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
      return res.ok
    } catch {
      return false
    }
  }

  async complete(req: CompletionRequest, signal?: AbortSignal): Promise<CompletionResult> {
    const res = await this.postChat(req, false, signal)
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

  async *stream(req: CompletionRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    let res = await this.postChat(req, true, signal)
    // The strict-server length rejection carries the server's own numbers — vLLM: "maximum context length
    // is 40960 tokens … your prompt contains AT LEAST 24577 input tokens". Two hard-won details:
    //
    //  · "at least" is a LOWER BOUND. The first version subtracted it with a 64-token margin and lost by
    //    one token — the true prompt was 65+ tokens past the report. The margin is now max(768, 3% of the
    //    reported input), sized to dwarf any observed slack.
    //  · This retry succeeding is what breaks a genuine DEADLOCK: compaction occupancy calibrates its wire
    //    overhead from each response's real usage, a restart resets that calibration, and an uncalibrated
    //    estimate sits below the trigger — so nothing compacts, and only a successful call can recalibrate.
    //    One landed retry restores usage flow; the next turn then compacts properly.
    //
    // Two rounds, margin doubled the second time (the fresher 400 carries a fresher bound). A third
    // identical failure means something other than length is wrong — throw honestly.
    for (let heal = 0; !res.ok && res.status === 400 && heal < 2; heal++) {
      const b = await res.text().catch(() => '')
      const m = /maximum context length is (\d+) tokens[\s\S]{0,200}?at least (\d+) input tokens/.exec(b)
      if (!m) throw new Error(`${this.id} HTTP 400: ${b.slice(0, 300) || res.statusText}`)
      const reportedInput = Number(m[2])
      const margin = Math.max(768, Math.ceil(reportedInput * 0.03)) * (heal + 1)
      const room = Number(m[1]) - reportedInput - margin
      if (room < 256) throw new Error(`${this.id} HTTP 400: ${b.slice(0, 300)}`)
      res = await this.postChat({ ...req, maxOutputTokens: room, contextWindow: undefined }, true, signal)
    }
    if (!res.ok || !res.body) {
      const b = await res.text().catch(() => '')
      throw new Error(`${this.id} HTTP ${res.status}: ${b.slice(0, 300) || res.statusText}`)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let stopReason: 'end_turn' | 'max_tokens' | 'tool_use' = 'end_turn'
    let usage: TokenUsage | undefined // E1: filled by the final chunk when stream_options.include_usage is honoured
    let fullText = '' // ADR-047: accumulated so the prose fallback can rescue text-channel tool calls at end
    // Tool calls stream as fragments of a JSON string, keyed by index — accumulate, parse ONCE at end.
    const toolCalls = new Map<number, { id: string; name: string; args: string }>()
    const announced = new Set<number>() // indexes whose tool_call_start already fired (once per call)

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
        // Reasoning goes by two field names in the wild: `reasoning` (OpenRouter, Ollama /v1) and
        // `reasoning_content` (DeepSeek convention — NVIDIA NIM, Fireworks, vLLM). Accept both.
        const reasoning = delta?.reasoning ?? delta?.reasoning_content
        if (reasoning) yield { type: 'thinking_delta', thinking: reasoning }
        if (delta?.content) {
          fullText += delta.content
          yield { type: 'text_delta', text: delta.content }
        }
        if (Array.isArray(delta?.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx: number = tc.index ?? 0
            const cur = toolCalls.get(idx) ?? { id: '', name: '', args: '' }
            if (tc.id) cur.id = tc.id
            if (tc.function?.name) cur.name += tc.function.name
            if (tc.function?.arguments) cur.args += tc.function.arguments
            toolCalls.set(idx, cur)
            // Announce the boundary ONCE per call, as soon as the name is known: everything after this is
            // silent argument generation, and the UI needs the transition to be an event, not a guess.
            if (cur.name && !announced.has(idx)) {
              announced.add(idx)
              yield { type: 'tool_call_start', name: cur.name }
            }
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

    // Emit each accumulated tool call as a complete tool_use. parseToolArgs repairs almost-JSON (trailing
    // commas, quotes, truncation) and carries UNREPAIRABLE args through as { __rawArgs } so runTool can tell
    // the model what it actually sent — the old `catch { input = {} }` produced "missing required file_path"
    // lies that weak models retried verbatim (item 4a / ADR-048).
    // forceSingleTool: a model whose template rejects multi-call turns (NIM llama-3.1-8b) — surface only the
    // FIRST call so the recorded assistant turn stays single-call and never poisons a later replay. The loop
    // just takes another turn for the rest; nothing is lost.
    const emit = this.forceSingleTool.has(req.model) ? [...toolCalls].slice(0, 1) : [...toolCalls]
    for (const [idx, c] of emit) {
      const parsed = parseToolArgs(c.args)
      yield { type: 'tool_use', id: c.id || `call_${idx}`, name: c.name, input: parsed.input, ...(parsed.via === 'repaired' ? { repaired: true } : {}) }
    }
    // ADR-047: prose fallback — ONLY when the native channel produced nothing. Weak models (llama3.2:3b,
    // measured 0/10 for exactly this) write their calls as ```json text; rescue the FIRST advertised-tool
    // match so the loop continues ReAct-style instead of treating the turn as a final answer.
    if (toolCalls.size === 0 && req.tools?.length) {
      const prose = extractProseToolCalls(fullText, req.tools.map((t) => t.name))
      if (prose.length > 0) {
        stopReason = 'tool_use'
        yield { type: 'tool_use', id: 'prose_0', name: prose[0].name, input: prose[0].input }
      }
    }
    yield { type: 'done', stopReason, usage }
  }
}
