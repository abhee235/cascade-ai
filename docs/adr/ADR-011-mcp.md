# ADR-011 — MCP integration: external tools, normalized into the `Tool` contract

**Status:** Accepted (Phase 9). Connection *timing* is ADR-014 (background discovery + lazy retry).

## Context
We want the agent to use tools that live in **other processes** — a filesystem server, GitHub, Postgres,
etc. — without writing a bespoke integration for each. MCP (Model Context Protocol) is the standard for
this: a server exposes tools over JSON-RPC (`initialize` → `tools/list` → `tools/call`), and `tools/list`
hands back each tool's `name` + `description` + `inputSchema` (JSON Schema).

## Decision
**An MCP tool becomes just another `Tool`.** The loop, scheduler, and permission gate don't change.

- **`mcp/mcpHub.ts` `McpHub`** — per-server state machine (`connecting → ready | failed | disabled`);
  on connect it does `tools/list` and wraps each returned tool as a Cascade `Tool`:
  - name `mcp__<server>__<tool>` (namespaced — can't collide with builtins; builtins win),
  - **raw JSON Schema in `parameters`** (MCP tools have no Zod schema),
  - conservative flags (`isReadOnly`/`isConcurrencySafe` = false) ⇒ gated like a write under `default` mode,
  - `call()` routes to `client.callTool(name, args)`.
- **`McpClient` interface** (`listTools`/`callTool`/`close`) abstracts the connection (DI, like the model
  provider): tests inject a fake; `mcp/sdkConnect.ts` is the real stdio adapter over
  `@modelcontextprotocol/sdk`.
- **Contract bend**: `Tool.inputSchema` is now optional and we add `parameters?` (raw JSON Schema).
  `schemaOf()` advertises `parameters` as-is (or converts Zod); `executeTool` skips `safeParse` when there's
  no Zod schema — **the MCP server validates its own args**.
- **Dynamic `ToolRegistry`** (`createRegistry(() => hub.readyTools())`) = builtins + ready MCP tools,
  injected via `LoopDeps`/`ToolContext`. It's recomputed per call, so tools appear as servers become ready.
  Per-session (not a module global) ⇒ safe for the multi-frontend web app (Phase 12).

## Consequences
- New external capabilities by **config**, no engine changes; one `Tool` abstraction covers builtin + MCP.
- MCP tools pass through the **same permission gate** (conservative flags ⇒ they prompt) and the same
  scheduler — important, since an external tool is less trusted than a builtin.
- Validation moves to the server for MCP tools (we forward args); builtins keep strict Zod validation.
- The registry is dynamic and per-session, replacing the old static module array.

## Prior art
The common design connects and discovers each server, then assembles one tool pool that merges MCP tools
with builtins (sorted, de-duped) and namespaces them `mcp__server__tool`. Same normalization; Cascade
differs only on connection *timing* (ADR-014: background + retry vs the usual blocking startup connect).
