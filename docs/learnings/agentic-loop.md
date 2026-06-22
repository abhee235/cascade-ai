# Learning: how the agentic loop terminates (and stays safe)

## Q: How does "if a turn has 0 tool calls, end" work — and isn't that fragile?
It's not a heuristic — it's the **semantics of tool-calling**. Each turn the model is in one of two states:
- emits `tool_use` block(s) → *"I'm not done; run these and give me results"*,
- emits only text → *"I'm done; here's the answer."*

Mutually exclusive. So **the model decides when to stop** by choosing whether to ask for another tool;
the loop just honors it. This is the classic **ReAct pattern** (Reason → Act → observe → repeat → Answer).
Every tool-using agent works this way.

**Detection nuance:** detect by **presence of tool_use blocks**, NOT by `stop_reason` — `stop_reason`
is not a reliable signal across providers. Filter the content for `type === 'tool_use'`, set a
needs-follow-up flag, and terminate when it is false. Cascade: `toolUses.length === 0`
→ terminal ([agentLoop.ts:73](../../packages/core/src/agent/agentLoop.ts#L73)).

## Q: What stops infinite loops / the model dragging the conversation?
Mostly the model's *training* keeps turns efficient — but never trust that alone. Backstops:

| Risk | Guard | Common implementation | Cascade |
|---|---|---|---|
| Infinite tool loop | **maxTurns** hard cap | return a `max_turns` end reason | ✅ `maxTurns` default 10 |
| Context grows each turn | compaction + token budget | a context-reduction step before each model call | ⏳ Phase 10 |
| Model cut off mid-output | max_output_tokens recovery | recovery paths in the loop | ⏳ Phase 11 |
| User cancels | AbortController | abort checks in the loop | ✅ `abort()` |
| Same tool keeps failing | errors returned as results (model adapts) + maxTurns | error tool results | ✅ both |
| Programmatic stop/continue | Stop hooks | stop-hook handling | ❌ out of scope |

**Key insight:** the loop *trusts* the model to terminate but *guarantees* termination with `maxTurns`
(the one hard wall). Compaction/recovery bound resource growth, not loop count.

## Q: Why did our tool card first appear "on top" / steps go missing?
Originally only the *terminal* turn emitted a `message`; intermediate turns' text was streamed then
dropped on `toolStart`. Fix: emit **each turn's** assistant `message` before running its tools
([agentLoop.ts:65-70](../../packages/core/src/agent/agentLoop.ts#L65)). Ordering comes purely from the
order of `yield`s in the loop: text → message → toolStart/toolResult → (loop) → next message.

The common design does the same — yield each assistant message and each tool_result in order; the UI
renders in arrival order. (A common protocol packs tool_use *inside* the assistant message; Cascade emits
separate `toolStart`/`toolResult` ActivityEvents — same ordering, flatter protocol.)
