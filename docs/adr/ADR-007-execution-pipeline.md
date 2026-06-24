# ADR-007 — Tool execution pipeline: lookup → validate → call → result (errors are results)

**Status:** Accepted (Phase 4 introduced it; Phase 5 formalizes + exercises it)

## Context
Between "the model asked for a tool" and "the tool ran" there's a defensive gap: the tool might not
exist, the args might be malformed, or the tool might fail at runtime. How those are handled decides
whether the agent is brittle or self-correcting.

## Decision
`tools/runTool.ts` `executeTool(toolUse, ctx)` is the single pipeline:
1. **Lookup** by name (`findTool`); unknown → error result.
2. **Validate** with Zod (`inputSchema.safeParse`); invalid → error result with the Zod message.
3. **Call** `tool.call(parsed.data, ctx)` inside try/catch.
4. **Wrap** as a `tool_result` block (`{ tool_use_id, content, isError }`).

**The defining rule: failures are RETURNED as `tool_result` with `isError: true` — never thrown.** The
error text goes back to the model as the tool result, so on the next turn it can fix its input or change
approach (self-correction). A tool may also choose to return `isError` itself (e.g. `Grep` on an invalid
regex, `Read` on a missing file) for the same reason.

Tools advertise themselves via `toolSchemas()` (Zod → JSON Schema), so the schema the model sees and the
schema we validate against are the same object — they can't drift.

## Consequences
- The agent recovers from bad tool calls instead of crashing the turn (observed: `Read nope.txt` →
  ENOENT result → model asks for a real path; bad regex → "Invalid regex" → model retries).
- Adding a tool never touches the pipeline — it's lookup-by-name + the contract.
- `maxTurns` still backstops a model that loops on a persistent error.

## Prior art
The common pipeline: name lookup, `inputSchema.safeParse`, a permission check, the `tool.call()` site,
with unknown-tool and validation errors returned as `is_error` tool_result user messages. Cascade builds
the essential pipeline; it adds permission checks (Phase 7) and concurrency (Phase 6) on top later.
