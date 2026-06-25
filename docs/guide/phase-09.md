# Phase 9 — MCP (background discovery + lazy retry)

**Goal:** use tools that live in *other processes* (MCP servers) — discovered in the **background** at
startup, normalized into the same `Tool` contract, gated by the same permissions.

## 🎯 You'll understand
- MCP = external tools over JSON-RPC (`initialize → tools/list → tools/call`); `tools/list` hands you each
  tool's JSON Schema, so an MCP tool becomes **just another `Tool`** — the loop/scheduler/gate don't change.
- **Why discovery needs a connection** (so pure-lazy can't advertise tools) → background discovery + lazy
  retry (ADR-014).
- How the **registry goes dynamic**: builtins + whatever MCP servers are currently `ready`, injected by DI.

## The ideas
1. **`McpClient` interface** abstracts the connection (DI, like the provider): tests inject a fake; the real
   `sdkConnect` wraps `@modelcontextprotocol/sdk` over stdio.
2. **`McpHub`** — per-server state machine `connecting → ready | failed | disabled`. `start()` connects every
   enabled server in the **background**; `retryFailed()` recovers a failed one on the next turn;
   `readyTools()` returns only callable tools.
3. **Contract bend** — MCP tools bring **raw JSON Schema**, not Zod. So `Tool.inputSchema` is optional and we
   add `parameters?`; `executeTool` skips `safeParse` for MCP (the server validates).
4. **Dynamic `ToolRegistry`** (`createRegistry(() => hub.readyTools())`) injected via `LoopDeps`/`ToolContext`
   — replaces the static module array, and is per-session (multi-frontend safe).

## What we built
**Core:**
- `mcp/mcpHub.ts` — `McpHub`, `McpClient`/`McpConnect` interfaces, `wrapMcpTool` (namespaced `mcp__s__t`,
  raw JSON Schema, conservative flags).
- `mcp/sdkConnect.ts` — the real stdio adapter (`@modelcontextprotocol/sdk`).
- `tools/toolRegistry.ts` — `ToolRegistry` + `createRegistry(extraTools)` + `defaultRegistry`; `schemaOf`.
- `Tool.ts` — `inputSchema` optional + `parameters?`; `ToolContext.registry`. `runTool.ts` — skip Zod for MCP.
- `scheduler.ts`/`agentLoop.ts` — look up + advertise via the injected registry (so MCP tools are gated & run).
- `session.ts` — builds the hub from `mcpServers`, `start()`s it in the background, `retryFailed()` each turn,
  exposes `dispose()`.

**Extension:** reads `cascade.mcpServers`, injects `sdkConnect`, disposes the old session on rebuild;
registered the `cascade.mcpServers` setting.

## Config: `.mcp.json` (portable, not VS Code settings)
MCP servers are configured in a project file **`<workspace>/.mcp.json`** — the editor-agnostic, committable
format other MCP clients use too, so it's copy-pasteable between tools and the Phase-12 web server reads the
same file. `core/mcp/loadMcpConfig.ts loadMcpServers(cwd)` reads it; the extension merges it over the
optional `cascade.mcpServers` setting (file wins).
```json
{ "mcpServers": { "playwright": { "command": "npx", "args": ["-y", "@playwright/mcp@latest"] } } }
```

## The `/mcp` panel
Type **`/mcp`** in the chat input → a panel lists each server with a status dot (●ready ◌connecting ✗failed
○disabled), tool count, and **Connect/Disconnect/Refresh**. It's a lightweight client-side slash command
(the webview intercepts `/mcp` and asks the host for `mcpStatuses()` instead of messaging the model).

## ✅ Test queries (F5)
1. Type `/mcp` → the panel shows `playwright` going `◌connecting → ●ready` (Refresh to update), with its tool
   count. (Connected in the background — no startup freeze.)
2. Ask "use the playwright MCP tools to open example.com and tell me the page title" → an `mcp__playwright__*`
   tool runs; the trace shows `tool_call`/`tool_result`. Disconnect it from the panel → its tools disappear.

## ✅ Self-check
*Why can't we advertise an MCP tool without connecting first, and how does "background discovery + lazy
retry" differ from both pure-lazy and a blocking startup connect?* → Advertising needs the tool's
`inputSchema`, which only `tools/list` (a live connection) provides — so pure-lazy never surfaces the tool.
We connect to discover, but in the **background** (no startup freeze, no mid-turn latency) and **retry**
failures lazily — unlike a blocking startup connect.

## Pitfalls
- BLOCKING startup on a slow/hung server (must be background, non-blocking).
- Advertising a tool before its server is `ready` (only `ready` servers contribute tools).
- Forgetting MCP tools are less trusted — keep the conservative flags so they pass the permission gate.
- Leaked subprocesses — `dispose()` closes clients; the extension disposes the old session on rebuild.
