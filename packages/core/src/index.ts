// @cascade/core — public surface of the headless engine.
export { createSession } from './session'
export type { CascadeSession, SessionOptions } from './session'
export type {
  ActivityEvent,
  InboundMessage,
  Message,
  ContentBlock,
  ToolDisplay,
  TodoItem,
  Question,
  QuestionOption,
  Answers,
} from './protocol'
// Provider abstraction (ADR-020): frontends build a provider via createProvider() and inject it.
export { createProvider } from './llm/factory'
// ADR-038: Ollama window detection helpers — the arch-ceiling fallback (+ its safe cap) shared by the
// server's modelInfo so the UI shows the same window the harness will run.
export { archContextLength, ARCH_FALLBACK_CAP, parseOllamaLimits } from './llm/providers/ollama'
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
export { sdkConnect, makeSdkConnect } from './mcp/sdkConnect'
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
// Compaction (ADR-039): layered, plan-driven context compaction. `compactionKindLabel` renders the
// `compacted` activity event; the plan/layers are internal but the label is part of the public surface.
export { compactionKindLabel } from './context/compactor'
// Resilience (ADR-016): retry/backoff + overflow→compact around the model call.
export { streamWithRecovery, completeWithRecovery, classifyError, RecoveryError } from './llm/resilience'
export type { ErrorKind, RecoveryOptions } from './llm/resilience'
// Sandbox (Phase 13.3): the generic execution seam. Core defines the shape; a frontend/wrapper injects an
// implementation (the server's Docker sandbox). Absent ⇒ tools run on the host.
export type { Sandbox, ExecOptions, ExecResult } from './sandbox/sandbox'
// Skills + named agents (ADR-055/056): loaders + the child-instructions builder are public so a wrapper
// can run a persona as its own TOP-LEVEL session (the server's plan stage) — not only as a subagent.
export { loadSkills } from './skills/skills'
export type { Skill } from './skills/skills'
// Argument-scoped tool grants (ADR-056 rung 4): the generic capability wall behind `Write(PLAN.md)`.
export { scopeToolsByGrants } from './tools/toolGrants'
export type { Tool, ToolResult, ToolContext } from './tools/Tool' // ADR-060: server-authored extra tools (Browser)
export { loadAgentDefs, agentChildInstructions } from './agent/agentDefs'
export type { AgentDef } from './agent/agentDefs'

// Model specs (ADR-067): per-model official limits + hosted capabilities — shared by every model manager
// UI (web server AND the extension) so they agree on what a model supports.
export { DEFAULT_LIMITS, limitsFor, MODEL_SPECS, recommendedMaxOutputTokens, specCapabilities, type ModelLimits } from './llm/modelSpecs'
