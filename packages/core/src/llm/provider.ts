// llm/provider.ts — the provider-agnostic seam.
//
// The core (agent loop, session) depends ONLY on this interface — never on Ollama/OpenAI/any backend
// directly. A factory (llm/factory.ts) builds a concrete provider from config and injects it.
// This is how we attach Ollama, OpenAI, Groq, OpenRouter, llama.cpp, etc. by configuration.
//
// Each provider owns its OWN wire-format translation. Cascade's internal message model stays
// provider-neutral (typed content blocks: text / tool_use / tool_result); a provider converts at its boundary.

import type { Message } from '../protocol'

export interface CompletionRequest {
  /** Full conversation so far, in Cascade's internal (provider-neutral) message model. */
  messages: Message[]
  /** Provider-specific model id, e.g. "qwen36-agentic:latest" or "gpt-4o". */
  model: string
  // Phase 3+ will add: system prompt. Phase 4+: tools. Phase 2 adds a stream() method below.
}

export interface CompletionResult {
  /** The assistant's reply text (Phase 1). Grows with tool calls / usage in later phases. */
  text: string
}

export interface ModelProvider {
  /** Stable id for logging/telemetry, e.g. "ollama", "groq". */
  readonly id: string
  /** One non-streaming completion (Phase 1). Phase 2 adds: stream(req, signal) → AsyncIterable<StreamEvent>. */
  complete(req: CompletionRequest, signal?: AbortSignal): Promise<CompletionResult>
}
