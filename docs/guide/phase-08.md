# Phase 8 — Bash + live tool progress (activity polish)

**Goal:** add `Bash` (a tool that produces output over *time*), stream its output live into the tool card,
and let the user **Stop** a running tool — finalizing the `ActivityEvent` protocol. Still no prose
streaming (ADR-013 holds).

## 🎯 You'll understand
- Why a *long-running* tool forces an `onProgress` callback and a `toolProgress` event.
- The **callback → async-generator bridge**: how to `yield` events that originate in a callback.
- How one `AbortController` cancels both the model stream and a child process.
- The Phase-6 payoff: `Bash` has **input-dependent** flags (`ls` read-only, `rm` not).

## The ideas
1. **Tool contract gains `onProgress`** — `call(input, ctx, onProgress?)`. Instantaneous tools ignore it;
   `Bash` calls it as stdout/stderr arrive.
2. **`toolProgress { id, chunk }`** ActivityEvent — live output into the card.
3. **The bridge** (the crux): a generator can't `yield` from inside a callback. So `scheduleTools` has
   each tool's `onProgress` push `{id, chunk}` onto a queue and call `wake()`; the loop drains the queue as
   `toolProgress`, then `await`s a promise stored in `wake`, looping until all tools settle. Single-threaded
   ⇒ no missed wakeup (nothing runs between the pending-check and the `await` that sets `wake`).
4. **Abort** — `Bash` spawns with `{ signal: ctx.abortSignal }` (Node kills the child). UI **Stop** posts
   inbound `abort` → `session.abort()` → cancels stream + child.

## What we built
**Core (`@cascade/core`):**
- `tools/builtins/Bash.ts` — `spawn(cmd, { shell, cwd, signal })`; streams stdout/stderr via `onProgress`;
  caps output (30k); nonzero exit ⇒ `isError`; **input-dependent** `isReadOnly`/`isConcurrencySafe` via a
  conservative safe-command allowlist (every chained segment must be safe).
- `Tool.ts` — `call()` gains optional `onProgress`. `protocol.ts` — `toolProgress` event.
- `tools/runTool.ts` — threads `onProgress` to `tool.call`.
- `tools/scheduler.ts` — the queue bridge: streams `toolProgress` while tools run; results still in order.
- `toolRegistry.ts` — registered `Bash`.

**Extension:**
- `ui/App.tsx` — `toolProgress` appends into the card (keeps the tail, capped 4k); a **Stop** button
  (replaces Send while busy) posts `abort`.

## ✅ Test queries (F5)
1. "Run `npm ls --depth=0`" (or `dir`/`ls`) → output streams into the card line by line; the answer follows.
2. Start a long command (e.g. `node -e "setInterval(()=>console.log(Date.now()),300)"`) → watch progress →
   click **Stop** → it halts (child killed), and the model reports cancellation.

## ✅ Self-check
*Which tools may stream progress, and how does a callback's output become a `yield`ed event?* → Any tool
that calls `onProgress` (here, `Bash`). The scheduler bridges callback→generator: `onProgress` pushes a
chunk onto a queue and wakes the loop, which drains the queue as `toolProgress` events between `await`s.

## Pitfalls
- Don't `await Promise.all` then emit progress after — that loses the *live* stream; you must interleave.
- Missed-wakeup: drain the queue *before* awaiting, and rely on single-threaded ordering so a push can't
  slip between the pending-check and registering `wake`.
- Zombie shells: always pass `signal` to `spawn` so abort kills the child.
- Read-only heuristic is conservative — unknown commands are treated as mutations (they'll prompt under
  `default` mode), which is the safe default.

## Deferred
- "Dispatch safe tools at `block_stop`" (start a read before the model finishes) — deferred; rationale in
  ADR-010 (marginal win vs. complexity against a fast local model).
