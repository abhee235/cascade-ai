# ADR-040 — Token accounting in the trace (CORE-PARITY A7 · PLAN-eval E1)

> **Status:** implemented (the trace layer). Session cost totals / UI display / pricing tables are deferred —
> the eval analyzer (PLAN-eval E4) is the first consumer and reads the trace directly.

## Context

Mature coding agents track per-turn tokens + cost. Cascade had **no token accounting at all**:
the provider discarded the backend's usage counters, and the forensic trace (ADR-023) recorded *what* was said
but not *what it cost*. The eval plan (PLAN-eval) needs two signals the trace lacked:

1. **Per-call token usage** — real backend counts (not chars/4 estimates) to compare harness variants on cost,
   and to sanity-check the estimator that sizes compaction.
2. **Compaction events** — which layer fired, when, and how much it reclaimed; ≥3 per run is the
   `context_thrash` diagnosis (⇒ tweak ADR-039 thresholds / ADR-038 window).

## Decision

Capture both **at the seams that already exist**; no new subsystem.

- **Provider seam** ([provider.ts]): `CompletionRequest.temperature?` (eval determinism) and
  `TokenUsage { inputTokens?, outputTokens? }` attached to the `done` StreamEvent. Optional throughout —
  backends that report nothing leave it `undefined`, never fabricated.
- **openaiCompat** ([openaiCompat.ts]): SSE path sends `stream_options: { include_usage: true }` (OpenAI spec;
  Ollama honours it; unknown-field-tolerant backends ignore it) and reads `chunk.usage`
  (`prompt_tokens`/`completion_tokens`) from the final chunk. Native `/api/chat` path reads
  `prompt_eval_count`/`eval_count` off the `done:true` object.
- **Loop → trace** ([agentLoop.ts]): the loop captures `done.usage` (reset on retry) and stamps it onto the
  existing `model_response` trace event; both compaction sites (pre-turn + forced overflow) emit a new
  `compaction { kind, tokensBefore, tokensAfter, forced }` trace event (estimates via `estimateTokens` — the
  same numbers the trigger used, so the event explains the trigger's own decision).

## Consequences

- The JSONL trace is now sufficient for the eval analyzer's cost + context metrics — per-turn tokens and
  compaction counts fall out of `model_response.usage` and `compaction` events; nothing else to instrument.
- Real usage vs `estimateTokens` becomes measurable (estimator calibration data for ADR-038's `tokensPerChar`).
- **Deferred:** session-level running totals + UI display; price tables (local models are free — cost display
  only matters for hosted providers); `complete()` usage (non-streaming side-queries like the compaction
  summary are uncounted for now).

## Verification

[usageTrace.test.ts] drives the **real** loop: `model_response.usage` equals the fake backend's counts;
`usage` stays `undefined` when unreported; a real compaction over a 400-token window emits
`compaction { kind:'summarized', forced:false }` with `tokensAfter < tokensBefore`. Full core suite green.

[provider.ts]: ../../packages/core/src/llm/provider.ts
[openaiCompat.ts]: ../../packages/core/src/llm/providers/openaiCompat.ts
[agentLoop.ts]: ../../packages/core/src/agent/agentLoop.ts
[usageTrace.test.ts]: ../../packages/core/test/usageTrace.test.ts
