# Phase 6 — Concurrency + Write & Edit

**Goal:** add write tools (`Write`, `Edit`) and run a turn's tools with the right concurrency:
read-only tools in parallel, writes serial.

## 🎯 You'll understand
Concurrency here is a **correctness** decision, not just speed: independent reads can't interfere, but
writes can race — so reads parallelize and writes serialize.

## Order we built it (and why)
1. **Write first** (6a) — it runs serially today, so it's a safe additive step; and you *need* a write
   tool to even test the read-vs-write distinction.
2. **Concurrency** (6b) — flags + scheduler, an optimization layer on top.

## The ideas
1. **Capability flags on the contract**: `isReadOnly?(input)` and `isConcurrencySafe?(input)` — methods,
   not booleans, because it can depend on input (Phase 8 Bash: `ls` safe, `rm` not). Default: false.
2. **Scheduler partition**: consecutive safe tools → one `Promise.all` batch; unsafe → solo. Results
   returned in original order. The loop does `yield* scheduleTools(...)`.

## What we built (all in `@cascade/core`)
- `tools/builtins/Write.ts` (mkdir -p + overwrite; returns a result; errors returned) — tagged unsafe.
- `tools/builtins/Edit.ts` (unique-substring replace; not-found/not-unique → isError self-correct) — unsafe.
- `Tool` contract: `isReadOnly?`/`isConcurrencySafe?`; tagged Read/Glob/Grep safe, Write/Edit unsafe.
- `tools/scheduler.ts` `scheduleTools()` — partition + parallel/serial + order preservation.
- `agentLoop` now calls `yield* scheduleTools(toolUses, ctx)` instead of the serial loop.

## Verification (deterministic)
```
[Read, Read, Write] →
toolStart:r1  toolStart:r2   (both reads start = one parallel batch)
toolResult:r1 toolResult:r2
toolStart:w1  toolResult:w1   (write runs solo)
results in order: r1,r2,w1
```

## ✅ Test queries (F5 Dev Host)
1. "Read package.json and tsconfig.base.json and compare them" → two **Read** cards (run in parallel),
   then the comparison.
2. "Create notes.txt with 'hello', then read it back" → a **Write** card (serial) then a **Read** card,
   in order; verify notes.txt exists.

## ✅ Self-check
*Why do read-only tools run in parallel but writes run serially?* → Independent reads can't interfere,
so parallel is safe and faster; two writes (or a read depending on a write) can race, so writes must
run one at a time. The scheduler enforces it via the `isConcurrencySafe` flag.

## Pitfalls
- Default `isConcurrencySafe` = false (fail-safe): a new tool isn't parallelized until you opt in.
- Preserve result order even when running in parallel (collect by id, return in request order).
- A write tool that isn't tagged unsafe could race — always tag mutating tools `false`.

## Not yet
- No permission checks yet — Write/Edit run without asking (Phase 7 adds allow/ask/deny). `Bash` is Phase 8.
