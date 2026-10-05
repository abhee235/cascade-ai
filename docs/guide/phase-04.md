# Phase 4 — The agentic loop + first tool (the heart)

**Goal:** Cascade stops just chatting and starts *doing* — it can call a `Read` tool, see the result,
and continue until it has the answer.

## 🎯 You'll understand
"Agentic" = a **`while`-loop around a stateless model**: call it; if it asked for a tool, run the tool,
append the result, call it again; stop when it stops asking. That recurse *is* the agent.

## The 3 ideas
1. **The loop & exit condition.** Detect tool use by the **presence of `tool_use` blocks**, not
   `stop_reason` (not a reliable signal across providers). No tool_use → terminal.
2. **Streaming tool-call accumulation.** The model streams tool args as fragments of a JSON string; the
   provider accumulates them by index and `JSON.parse`s **once** at the end, emitting a complete
   `tool_use` event. The loop only ever sees finished tool calls.
3. **The tool contract.** `name` + `description` + Zod `inputSchema` (validates AND → JSON Schema) +
   `call()`.

## What we built (all in `@cascade/core`)
- `tools/Tool.ts` (contract + `ToolContext`/`ToolResult`), `tools/builtins/Read.ts`, `tools/toolRegistry.ts`
  (`findTool`, `toolSchemas` via `z.toJSONSchema`).
- `llm/provider.ts` — `ToolSchema`, `CompletionRequest.tools`, `StreamEvent` += `tool_use`.
- `llm/providers/openaiCompat.ts` — sends `tools`; **bridges** `tool_use`/`tool_result` ⇄
  `tool_calls`/`role:'tool'`; accumulates streamed `tool_calls` and emits complete `tool_use`.
- `tools/runTool.ts` — `executeTool()`: lookup → `safeParse` → `call` → `tool_result` (errors returned, not thrown).
- `agent/agentLoop.ts` — `runAgentLoop()`: the while-loop; `session.ts` delegates to it.
- `protocol.ts` + `App.tsx` — `toolStart`/`toolResult` events + a tool card in the transcript.

## Verification (headless smoke)
```
status: Thinking…
TOOL START: Read | Reading …/package.json
TOOL RESULT ok=true: {"name":"cascade-monorepo"…
status: Thinking…                ← 2nd model call, now sees the file
FINAL: The name field in package.json is cascade-monorepo.
```

## ✅ Test queries (F5 Dev Host)
1. "Read package.json and tell me the project name" → a **Read** tool card appears, then the answer
   (`cascade-monorepo`) derived from the file.
2. "What scripts are defined?" → Read → answer lists the scripts. (Model→tool→model round-trip.)

## ✅ Self-check
*What exact condition ends the loop, and what makes it run another turn?* → It ends when a model reply
contains **zero `tool_use` blocks** (terminal). It loops when there ARE tool_use blocks: we run them,
append the `tool_result`s, and call the model again so it can use them.

## Pitfalls
- Don't trust `stop_reason`; detect by tool_use presence.
- Don't parse tool-arg JSON per-delta; accumulate and parse once (done in the provider).
- Return tool errors as results (`isError`), don't throw — lets the model recover (Phase 5).

## Not yet
- One tool, run serially; no concurrency (Phase 6), no permissions (Phase 7), no recovery/compaction
  (Phases 10–11). `maxTurns` (default 10) is the only guard.
