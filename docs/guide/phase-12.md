# Phase 12 — Resilience & Subagents (capstone)

**Goal:** make the loop survive failure (retry/recover) and learn to **delegate** subtasks to nested agents.

## 🎯 You'll understand
- The retry **taxonomy** — what's transient (retry), recoverable (compact/re-auth), or fatal (fail fast).
- Backoff + jitter, and how **overflow→compact** closes the loop with Phase 11.
- Why **delegation = context isolation** — a subagent does noisy work in its *own* context and returns only a
  summary, so multi-step agents scale.

## Part A — Resilience (ADR-016)
`llm/resilience.ts`:
- **`classifyError`** → `abort | overflow | transient | fatal` (a should-retry classification table).
- **`streamWithRecovery(make, opts)`** wraps the provider stream: transient → exp backoff `min(500·2^n, 30s)`
  + jitter (≤4×) then `RecoveryError`; overflow → `onOverflow` (reactive compact @0.6) then retry (capped);
  abort → rethrow. **Live streaming preserved** (re-stream on retry; final `message` is authoritative).
- Wired into the loop's model call; `onOverflow` reuses the Phase-11 compactor.

## Part B — Subagents (ADR-017)
`tools/builtins/Subagent.ts` — `{ description, prompt, subagent_type? }`:
- The loop injects `ctx.spawnSubagent` (avoids an import cycle). The tool runs a **nested `runAgentLoop`** with
  its **own messages**, a **filtered registry** (`registryOf`, always minus `Subagent`; `explore` =
  read-only), `depth+1`, `maxTurns 8` — and returns **only the child's final text** as the tool_result.
- **Depth cap (2)** + child registry excludes `Subagent` ⇒ no runaway recursion. Child failure → error
  result (parent adapts). The child's steps live in its own context (+ the trace), not the parent's.

## ✅ Test queries (F5)
1. **Resilience:** start a turn, then `ollama stop` (or kill the server) briefly mid-request → the turn should
   **retry/back off** rather than crash; bring Ollama back → it recovers. (Or set `cascade.contextWindow` very
   low to force overflow → it compacts then continues.)
2. **Subagent:** "Use a subagent to explore how the tool registry works, then summarize." → a single
   **`Subagent (explore)`** tool card runs; the parent answers from the returned summary. The trace shows the
   child's nested `model_request`/`tool_call`s; the parent's context stays small.

## ✅ Self-check
*Which failures retry vs fail fast, and why does returning only a subagent's summary (not its 30 tool calls)
let multi-step agents scale?* → Transient (network/5xx/429) retry with backoff; overflow compacts then
retries; abort/4xx fail fast. Returning only the summary keeps the parent's context lean, so it can run far
longer before hitting the window (and compaction has less to do).

## Tests
`resilience.test.ts` (taxonomy + retry/overflow/abort/exhaustion), `subagent.test.ts` (depth guard,
delegation, e2e nested loop — provider called 3× proving the child ran its own loop). 68 deterministic + 1 live.

## Pitfalls / deferred
- Don't retry deterministic 4xx; don't lose abort during a backoff sleep.
- Always exclude `Subagent` from the child registry (recursion) AND cap depth.
- Deferred: model fallback ladder, retry-after parsing, background/async + worktree subagents, agent teams,
  nested-activity UI.
