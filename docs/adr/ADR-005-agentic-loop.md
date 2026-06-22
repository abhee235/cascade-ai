# ADR-005 — The agentic loop is a while-loop generator that recurses on tool_use

**Status:** Accepted (Phase 4)

## Context
An agent must be able to call tools, see results, and continue — not just answer once. We need a loop
shape that's simple, streamable, and follows the standard agent-loop shape so the curriculum stays
faithful.

## Decision
`agent/agentLoop.ts` `runAgentLoop(messages, deps)` is an **async generator** with a `while(true)`:

1. Stream the model with the full history + system prompt + tool schemas.
2. Collect any `tool_use` blocks from the stream (and accumulate text/thinking, forwarded live).
3. **Detect tool use by PRESENCE of tool_use blocks — not `stop_reason`** (`stop_reason` is not a
   reliable signal across providers). Append the assistant turn (thinking/text/tool_use) to history.
4. **Terminal:** zero tool_use → emit the final `message`, `turnDone`, return.
5. Otherwise: run each tool (`executeTool`), emit `toolStart`/`toolResult`, append the `tool_result`
   blocks as a user message, and **loop** — the next call sees the results. (The recurse = the agent;
   cf. `query.ts:1716`.)
6. A `maxTurns` guard (default 10) stops runaways (Phase 11 hardens this).

The session (`createSession`) owns the `Message[]` history and the AbortController; `submit()` just
appends the user turn and `yield*`s the loop.

## Consequences
- The loop is the whole "agent" — everything later (concurrency, permissions, compaction, subagents)
  wraps this skeleton.
- Streaming + tools coexist: deltas are forwarded live; tool calls are collected and run between model calls.
- `maxTurns` is the only safety valve for now; recovery/compaction are deferred.

## Prior art
The standard agent loop: a "needs follow-up" flag set by filtering the turn's `tool_use` blocks, a tool
dispatch, append the results + `continue`, and terminate when no follow-up is needed. Cascade builds that
skeleton, minus recovery/compaction/stop-hooks/streaming-executor.
