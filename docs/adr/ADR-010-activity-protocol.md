# ADR-010 — The ActivityEvent protocol + live tool progress

**Status:** Accepted (Phase 8)

## Context
By Phase 8 the agent runs tools that take *time* (`Bash`), not just instantaneous file ops. The frontend
needs to show what's happening *as it happens* — without painting prose token-by-token (ADR-013 still
holds). We also need to finalize the one serializable protocol that every frontend renders (extension now,
web later), and a way to stop a long-running tool.

## Decision
`core/protocol.ts` `ActivityEvent` is the **single wire protocol** core → frontend (plain JSON, ADR-018):
`status` · `thinking_delta` · `text_delta` · `toolStart` · `permission` · **`toolProgress`** · `toolResult`
· `message` · `turnDone`. Phase 8 adds **`toolProgress { id, chunk }`** — partial output from a running tool.

**The callback → generator bridge.** A tool streams via `call(input, ctx, onProgress)`. But the scheduler
is an async *generator* and can't `yield` from inside a callback. So `scheduleTools` bridges: each tool's
`onProgress` pushes `{id, chunk}` onto a queue and calls `wake()`; the generator loop drains the queue as
`toolProgress` events, then `await`s a promise it stores in `wake`, looping until all tools settle. The
single-threaded event loop guarantees no missed wakeup — nothing runs between the pending-check and the
`await` that registers `wake`.

**Abort.** `Bash` spawns with `{ signal: ctx.abortSignal }`, so Node kills the child when the session
aborts. The UI **Stop** button posts inbound `abort` → `session.abort()` → the AbortController cancels the
model stream *and* the child process. No zombie shells.

**Deliberate simplification (deferred).** The curriculum lists "dispatch concurrency-safe tools at
`block_stop`" (start a read before the model finishes streaming). We **defer** it: the loop still
collects all `tool_use`s and schedules after `done`. Rationale — against local Ollama the stream-to-`done`
is fast and the tools are the slow part, so the latency win is marginal versus the added complexity of
running tools while still consuming the stream. Revisit if a remote/fast model makes it worthwhile.

## Consequences
- One protocol, many frontends: the web app (Phase 12) renders the identical events over WebSocket.
- `toolProgress` gives the "watch it run" UX (Bash stdout streams into the card) with no prose streaming.
- Stop is honored end-to-end (model stream + child process) via one AbortSignal.
- Progress is display-only; the authoritative output is still the tool_result (and the full, untruncated
  copy lands in the JSONL trace — ADR-023).

## Prior art
A streaming tool executor can start safe tools as their block closes (the optimization we deferred); a
progress callback streams tool output; one AbortController cancels the request and in-flight tools.
Cascade builds the protocol + progress + abort, and records the early-dispatch deferral here.
