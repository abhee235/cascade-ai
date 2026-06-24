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
// Permissions (ADR-009): the frontend picks a mode; checkPermission is the gate.
export { checkPermission } from './permissions/gate'
export type { PermissionMode, PermissionDecision, PermissionState } from './permissions/gate'
// Observability (ADR-023): inject a Tracer to capture a forensic JSONL trace of a run.
export { NoopTracer, JsonlTracer } from './observability/tracer'
export type { Tracer, TraceEvent } from './observability/tracer'
