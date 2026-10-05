# ADR-012 — Context compaction (layered, ratio-sized, summary-with-boundary)

**Status:** Accepted (Phase 11). Built *with* the memory consolidation deferred from Phase 10 (they couple).

## Context
The model is stateless: we resend the whole transcript each turn, and it grows (tool output is the worst
bloat). A finite window forces management. Cascade is provider-agnostic (8k local ↔ 200k cloud), so absolute
buffers don't transfer — sizing must be **dynamic**. Naive truncation loses decisions; good compaction is
**surgical**: keep what's still relevant, compress the rest.

## Prior art (production agents + 2026 research)
How mature production coding agents compact:
- **Thresholds**: `effective = contextWindow − min(maxOutputTokens, 20_000)`;
  `threshold = effective − 13_000` (~93% of effective). Reserve is empirical (p99.99 summary = 17,387 tok).
  `%`-override + a window-override env var for testing.
- **Circuit breaker**: stop after **3** consecutive failures (one deployment saw 1,279 sessions hit 50+,
  wasting ~250K API calls/day) — don't retry a doomed compaction every turn.
- **Cheap→expensive pipeline**: snip → tool-result budget → microcompact → collapse → *then*
  summarize. If a cheap step gets under threshold, summarization is skipped (granular context preserved).
- **Structured summary**: a no-tools preamble + an `<analysis>` scratchpad (stripped) + the
  summary under fixed headings — revised 2026-10 to seven: goal, state of the work, files, decisions and
  constraints, problems and fixes, every user message, next step **with a verbatim quote** to prevent drift. BASE vs **PARTIAL**
  variant (partial keeps a recent segment verbatim, summarizes only the older side).
- **Boundary, not delete**: `[boundaryMarker, summary, ...keptMessages, ...reInjectedFiles]`;
  the loop reads only post-boundary messages; the raw transcript stays on disk. Recent files re-injected.
- **Session-memory-compaction tried first** (experiment) — i.e. production agents already couple memory +
  compaction.

2026 research adds two cheap techniques worth stealing:
- **Observation masking** — replace *old tool outputs* with placeholders (keep the reasoning trace).
  *Matches* LLM-summarization's task-completion on SWE-bench at **~half the cost** — often you don't need to
  summarize at all, just mask tool spew. [arxiv 2601.07190]
- **Two-phase surgical** — prune verbose tool outputs beyond the recent N tokens, *then* summarize only if
  still over. (The snip/budget steps above are this.)

## Decision (Cascade)
A **layered, ratio-sized** compactor, `context/compactor.ts → compactIfNeeded(messages, opts)`:

1. **Dynamic sizing** (ADR-012 sibling of the Phase-10 decision): `window = cfg.contextWindow ??
   provider.contextWindow ?? 8192`; `compactAt = window * compactRatio (0.8)`; `keepRecent = window *
   keepRecentRatio (0.25)`. Output reserve implicit in `compactRatio < 1`. (`chars/4` token estimate.)
2. **Phase A — observation masking (cheap, no LLM):** replace large/old `tool_result` blocks (outside the
   recent window) with a `[output masked — N chars]` placeholder, keeping the assistant's reasoning. Often
   enough on its own.
3. **Phase B — partial summarize (only if still ≥ compactAt):** split `[older, recent]` at `keepRecent`;
   ask the model (tools denied) for the structured summary of `older` (`<analysis>` stripped); emit
   `[boundaryMarker, summaryMessage, ...recent]`. Loop continues from the summary; transcript + JSONL trace
   stay intact.
4. **Coupled curation:** before discarding `older`, harvest durable facts from it via the Phase-10
   consolidation (ADD/UPDATE/DELETE/NOOP → memory) — information-loss-event curation (memory-write-policy).
5. **Circuit breaker** (N consecutive failures → stop). Checked **before** each model call in the loop.

## Consequences
- Tool-heavy contexts compact cheaply (masking) without an LLM call; only conversation-heavy ones summarize.
- Recent work kept verbatim; nothing load-bearing lost (structured summary); memory harvested before loss.
- Ratio sizing works at 8k and 200k unchanged; all overridable.
- Defer: microcompaction (per-item), agent-controlled compaction (a compress tool), RAG recall of old turns,
  disk-offload of masked output, real tokenizer.

## Sources
arxiv 2601.07190 (active context compression / observation masking); published engineering write-ups on
compaction vs summarization and on agent-framework compaction.
