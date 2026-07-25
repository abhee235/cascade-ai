# ADR-074 — Dynamic, cache-safe, reload-safe archival recall

Status: Accepted (2026-07-24)
Supersedes the recall half of Phase-10 static retrieval; builder `autoMemory` flipped ON.

## Context

Archival recall existed but was **static**: `session.ts` embeds the *first* user text once at submit-start and
injects the hits into the system-prompt **prefix** (`buildSystemPrompt({ recalled })`). Two consequences:

1. **Frozen** — a fact the model discovers at turn 9 ("the CTA colour comes from `theme.primary`, not the
   button") is invisible to recall for the rest of the build. When compaction later summarises turn 9 away, the
   model re-diagnoses it from scratch. Measured in the Velocarta build: the CTA colour was fixed at the call
   site three separate times because its source (the theme) had scrolled out of context.
2. **Prefix-injected** — recall lived in the cached system prefix. Making it *change* per turn there would
   re-prefill the entire window every turn — the exact KV-cache thrash ADR-038/039/061 fought.

Builder `autoMemory` was therefore **OFF**: with recall unable to help mid-build and curation costing both dead
air *and* (historically) a prefix mutation, it wasn't worth it.

## Two constraints, both MEASURED before building

- **Cache**: a changing **prefix** re-prefills everything; a changing **tail** is just new tokens after the
  cached prefix. So dynamic recall must append at the tail, never the system prompt.
- **Single-runner reload**: search embeds the query via Ollama. The fear was that hitting `nomic-embed-text`
  would evict `qwen36-agentic` (the ADR-038/061 reload). **Test (2026-07-24)**: after an embed call, `ollama ps`
  shows *both* models resident — qwen was **not** evicted (`OLLAMA_MAX_LOADED_MODELS` admits the 0.3 GB embed
  model alongside qwen). So a per-turn search is reload-safe on this box.

## Decision

Add **dynamic recall** in the agent loop, additive to (not replacing) the frozen system-prefix recall:

- Each turn, after compaction and the todo nudge, build a query from the model's **current focus**
  (`recentFocusText` — most recent assistant intent + trailing user text; tool_result blobs excluded).
- Search archival; keep only **strong, NEW** hits (score ≥ **0.6**, higher than static recall's 0.45 — a wrong
  tail injection is noise on every later prefill; surfaced once per session via a dedup set).
- Append them via `appendReminder` at the **tail** (cache-safe), framed as *recall to verify*, not an order.
- **Throttle**: skip the embed when the focus is unchanged since the last search (mid-tool-loop the focus is
  identical across turns — re-embedding would burn latency for an identical result).
- Best-effort: any retrieval failure is swallowed; recall never derails a turn.
- Flip builder **`autoMemory` ON**: curation now writes durable facts at compaction for recall to resurface.
  Prefix-mutation objection is void (tail injection); only bounded curation dead-air remains — a trade the user
  chose (one recalled fact beats a dozen re-diagnosis turns).

## Files

- `packages/core/src/agent/dynamicRecall.ts` — `recentFocusText`, `selectNewRecall`, `buildRecallReminder`,
  `recallForTurn` (+ `DYNAMIC_RECALL_MIN_SCORE`).
- `packages/core/src/agent/agentLoop.ts` — `surfacedMemories` set + `lastRecallQuery` throttle; per-turn call
  after the todo nudge; emits `recall` trace event.
- `packages/core/src/observability/tracer.ts` — `recall` TraceEvent.
- `packages/server/src/otelTracer.ts` — `recall: memories surfaced` mark.
- `packages/server/src/projectManager.ts` — builder `autoMemory: true`.
- `packages/core/test/dynamicRecall.test.ts` — 9 unit tests (query focus, once-only surfacing, throttle, guards).

## Consequences / how we'll know it worked

- Inert on short builds (no compaction ⇒ nothing curated ⇒ nothing to recall) — correct; short builds don't
  forget. It earns its keep only on long builds that compact.
- Validate on the next long build: `recall` events firing in the trace, and the re-diagnosis fix-loop (same
  fact fixed N times) shrinking vs the Velocarta baseline. If `recall` never fires on a long build, curation
  isn't harvesting the right facts — tune the curator, not this gate.
- Watch per-turn embed latency in the trace; if it shows up as dead air, widen the throttle (every N turns).
