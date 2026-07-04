// llm/provider.ts — the provider-agnostic seam.
//
// The core (agent loop, session) depends ONLY on this interface — never on Ollama/OpenAI/any backend
// directly. A factory (llm/factory.ts) builds a concrete provider from config and injects it.
// This is how we attach Ollama, OpenAI, Groq, OpenRouter, llama.cpp, etc. by configuration.
//
// Each provider owns its OWN wire-format translation. Cascade's internal message model stays
// provider-neutral (typed content blocks: text / tool_use / tool_result); a provider converts at its boundary.

import type { Message } from '../protocol'

/** Provider-neutral tool advertisement sent to the model (Phase 4). */
export interface ToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown> // JSON Schema for the tool's input
}

export interface CompletionRequest {
  /** Full conversation so far, in Cascade's internal (provider-neutral) message model. */
  messages: Message[]
  /** Provider-specific model id, e.g. "qwen36-agentic:latest" or "gpt-4o". */
  model: string
  /** System prompt (identity + environment), prepended by the provider. Phase 3. */
  system?: string
  /** Tools the model may call this turn. Phase 4. */
  tools?: ToolSchema[]
  /** Sampling temperature (E1/eval: 0 for determinism). Omit ⇒ backend default. */
  temperature?: number
  /** ADR-038 ENFORCEMENT: the ALLOCATED context window the caller is planning against. The provider must
   *  put it on the wire (Ollama: options.num_ctx via the native path) — otherwise the compactor protects a
   *  window the model may not actually have, and Ollama silently front-truncates the prompt (system prompt
   *  lost mid-session, no error anywhere). Omit ⇒ backend default (hosted providers: fixed windows). */
  contextWindow?: number
  /** ADR-038: output-token cap (Ollama num_predict / OpenAI max_tokens). */
  maxOutputTokens?: number
}

/** Token counts reported by the backend for one completion (E1 / ADR-040). Fields are optional because not
 *  every backend reports them (and OpenAI-compat streams only do so via stream_options.include_usage). */
export interface TokenUsage {
  inputTokens?: number // prompt tokens (OpenAI prompt_tokens / Ollama prompt_eval_count)
  outputTokens?: number // completion tokens (OpenAI completion_tokens / Ollama eval_count)
}

export interface CompletionResult {
  /** The assistant's reply text (Phase 1). Grows with tool calls / usage in later phases. */
  text: string
}

/**
 * Events a provider yields while streaming (Phase 2). INTERNAL to the llm↔session boundary — these
 * never reach the frontend. The session consumes them, accumulates, and emits frontend ActivityEvents
 * (status + a final whole `message`). That separation is the activity-first divergence (ADR-013).
 * Phase 4 extends this with tool_use_start / tool_use_delta / block_stop.
 */
export type StreamEvent =
  | { type: 'text_delta'; text: string } // a chunk of the answer
  | { type: 'thinking_delta'; thinking: string } // a chunk of reasoning (e.g. Ollama delta.reasoning)
  | { type: 'tool_use'; id: string; name: string; input: unknown } // a COMPLETE tool call (args accumulated + parsed)
  | { type: 'retry'; attempt: number; delayMs: number; reason: string } // synthetic: streamWithRecovery is retrying (resets partial output)
  | { type: 'done'; stopReason: 'end_turn' | 'max_tokens' | 'tool_use'; usage?: TokenUsage } // usage: E1/ADR-040

export interface ModelProvider {
  /** Stable id for logging/telemetry, e.g. "ollama", "groq". */
  readonly id: string
  /** One non-streaming completion (Phase 1). */
  complete(req: CompletionRequest, signal?: AbortSignal): Promise<CompletionResult>
  /** Streamed completion (Phase 2): yields deltas as they arrive. */
  stream(req: CompletionRequest, signal?: AbortSignal): AsyncIterable<StreamEvent>
  /** Embed texts for semantic (archival) memory (Phase 10, ADR-015). `model` is the embedding model id
   *  (e.g. "nomic-embed-text"). Optional — archival memory degrades to keyword search when absent. */
  embed?(texts: string[], model: string, signal?: AbortSignal): Promise<number[][]>
  /** ADR-038: probe the model's ACTUAL runtime limits so the compactor/prompt size against reality, not a
   *  static guess. For Ollama this reads the Modelfile's `num_ctx` (the ALLOCATED window — NOT the arch
   *  `context_length`, which is the trained ceiling) + `num_predict`. Optional; returns {} when unknown or the
   *  backend has no such endpoint (hosted providers 404 → fall back to the model map). */
  detectModelLimits?(model: string, signal?: AbortSignal): Promise<{ contextWindow?: number; maxOutputTokens?: number }>
}
