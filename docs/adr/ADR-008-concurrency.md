# ADR-008 — Concurrency: read-only tools parallel, writes serial

**Status:** Accepted (Phase 6)

## Context
A single model turn can request several tool calls. Running them all serially is safe but slow;
running them all in parallel is fast but unsafe — two writes can race, or a read can depend on a
not-yet-finished write. We need a rule that's fast *and* correct.

## Decision
**Parallelism is a correctness decision, not just speed.** Tools declare capability via the `Tool`
contract:
- `isReadOnly?(input)` — does it mutate state? (also used by permissions in Phase 7)
- `isConcurrencySafe?(input)` — safe to run alongside others? Default when absent: **false** (conservative).

`tools/scheduler.ts` `scheduleTools()` partitions a turn's tool calls:
- consecutive **concurrency-safe** tools → one batch run with `Promise.all` (parallel),
- any **unsafe** tool → its own solo batch (serial).

Results are returned in the **original order** (collected by id), regardless of finish order. The loop
calls `yield* scheduleTools(...)` instead of a serial for-loop.

Tagging: `Read`/`Glob`/`Grep` → `isReadOnly`/`isConcurrencySafe` = true. `Write`/`Edit` → false.

## Consequences
- Independent reads run concurrently (faster); writes never overlap (safe).
- Default-false means a new tool is treated as unsafe until you opt in — fail-safe.
- Order preservation keeps the transcript/model input stable even with parallel execution.
- Proven deterministically: `[Read, Read, Write]` → both reads start before any result (one batch),
  then the write runs solo; results returned `r1,r2,w1`.

## Prior art
The common approach partitions a turn's tool calls by `isConcurrencySafe`, runs safe batches concurrently
and others serially, applying context modifiers in order. A shell tool's concurrency safety is typically
its read-only-ness, and that is input-dependent (`ls` safe, `rm` not) — which is why our flags are
methods, not booleans.
