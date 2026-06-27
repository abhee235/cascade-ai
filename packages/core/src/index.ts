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
// MCP (ADR-014): register servers; the real stdio adapter is sdkConnect (frontends inject it).
export { McpHub } from './mcp/mcpHub'
export type { McpServerConfig, McpConnect, McpClient, McpStatus, McpServerStatus } from './mcp/mcpHub'
export { sdkConnect } from './mcp/sdkConnect'
export { loadMcpServers, MCP_CONFIG_FILE } from './mcp/loadMcpConfig'
// Memory (ADR-015): durable cross-session core memory, injected into the system prompt.
export {
  loadMemory,
  memoryFiles,
  appendMemory,
  replaceMemory,
  forgetMemory,
  memoryPaths,
  MEMORY_FILE,
  MEMORY_LOCAL_FILE,
} from './memory/memoryStore'
export { createArchival } from './memory/archival'
export type { ArchivalMemory, ArchivalHit, ArchivalEntry } from './memory/archival'
// Resilience (ADR-016): retry/backoff + overflow→compact around the model call.
export { streamWithRecovery, classifyError, RecoveryError } from './llm/resilience'
export type { ErrorKind, RecoveryOptions } from './llm/resilience'
