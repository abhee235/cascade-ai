// @cascade/core — public surface of the headless engine.
export { createSession } from './session'
export type { CascadeSession, SessionOptions } from './session'
export type {
  ActivityEvent,
  InboundMessage,
  Message,
  ContentBlock,
} from './protocol'
// Provider abstraction (ADR-020): frontends build a provider via createProvider() and inject it.
export { createProvider } from './llm/factory'
export type { ProviderConfig } from './llm/factory'
export type { ModelProvider, CompletionRequest, CompletionResult } from './llm/provider'
