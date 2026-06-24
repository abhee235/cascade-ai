# Phase 5 — Execution pipeline + Glob & Grep

**Goal:** harden + formalize the tool pipeline (lookup → validate → call → result) and add two more
read-only tools, `Glob` and `Grep`. The headline lesson: **errors fed back to the model make it
self-correcting.**

## 🎯 You'll understand
The defensive gap between "the model asked" and "the tool ran", and why returning errors as tool
results (instead of throwing) lets the agent recover on its own.

## The ideas
1. **Pipeline** (already built in Phase 4, formalized here as ADR-007): `executeTool` does lookup →
   `inputSchema.safeParse` → `call` → wrap. Unknown tool / bad args / thrown error all become
   `tool_result` with `isError:true`.
2. **Self-correction**: the error text goes back to the model; next turn it fixes its input or approach.
   Seen with `Read nope.txt` (ENOENT) and `Grep` on an invalid regex.
3. **One schema, two uses**: `toolSchemas()` converts each Zod `inputSchema` to JSON Schema for the
   model — the advertised schema and the validation schema are the same object (can't drift).

## What we built (all in `@cascade/core`)
- `tools/builtins/Glob.ts` — `fast-glob` over the workspace (ignores node_modules/dist/.git, caps 200).
- `tools/builtins/Grep.ts` — regex over file contents → `file:line: text` (caps 100; invalid regex →
  `isError` result for self-correction).
- Registered both in `tools/toolRegistry.ts` (`tools = [Read, Glob, Grep]`).
- ADR-007 documents the pipeline (which `runTool.ts` already implemented).

## Verification (headless)
```
TOOL: Glob | Finding **/*.ts
  ok=true: index.ts\nprotocol.ts\nsession.ts\nagent/agentLoop.ts…
MSG: There are 14 .ts files under packages/core/src …
```

## ✅ Test queries (F5 Dev Host)
1. "Find all .ts files under packages/core/src" → a **Glob** card, then the count/list.
2. "Search for 'createSession' in the codebase" → a **Grep** card with `file:line` matches; then try a
   deliberately broken regex (e.g. "search for `(`") → the tool returns "Invalid regex", and the model
   retries with a corrected pattern (self-correction visible).

## ✅ Self-check
*Why return tool errors as results instead of throwing?* → So the error reaches the model as the tool's
output; it can then fix its arguments or change approach on the next turn. Throwing would kill the turn
and the model would never learn what went wrong.

## Pitfalls
- Grep reads files directly (no ripgrep) — fine for a workspace, capped; production agents use ripgrep for speed.
- Always ignore node_modules/dist/.git or Glob/Grep drown in noise.
- Keep results capped — unbounded tool output blows the context window.

## Not yet
- Tools still run **serially**, one at a time (concurrency = Phase 6). No permission checks yet (Phase 7).
