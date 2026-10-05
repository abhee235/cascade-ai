# Phase 11 — Context compaction (+ coupled, event-driven memory curation)

**Goal:** keep long conversations within the model's window without losing what matters — and harvest durable
memory at the moment context is discarded. (Memory took Phase 10, so compaction is its own phase now.)

## 🎯 You'll understand
- Why compaction is **surgical, layered**, and **ratio-sized** (works at 8k and 200k unchanged).
- Why we keep a **boundary/summary** instead of deleting (transcript + trace stay intact).
- The cheap win: **observation masking** (mask old tool output) before any LLM summarization.
- Why **memory curation couples to compaction** (harvest facts from the chunk being discarded).

## The algorithm (ADR-012)
Checked **before each model call** in the loop:
1. **Dynamic sizing**: `window = cascade.contextWindow ?? model-map ?? 8192`; `compactAt = window*compactRatio
   (0.8)`; `keepRecent = window*keepRecentRatio (0.25)`. Token estimate = chars/4. No hardcoded buffers.
2. **Phase A — observation masking** (cheap, no LLM): replace large `tool_result`s in the OLDER region with
   `[output masked — N chars]`. Often enough on its own (matches summarization on SWE-bench at ~half cost).
3. **Phase B — partial summarize** (only if still over): split `[older | recent]` at the keepRecent boundary;
   summarize `older` with the structured summary prompt (TEXT-ONLY); emit `[summaryMessage, ...recent]`.
   The loop continues from the summary; the raw history is swapped **in place** (`messages.splice`), so the
   JSONL trace + transcript are untouched — you literally watch the next `model_request` shrink.
4. **Coupled curation** (`onDiscard`): before `older` is summarized away, harvest durable facts from it into
   archival memory (Mem0-style **ADD/NOOP** consolidation — semantic dedup). Opt-in (`cascade.autoMemory`).

## What we built
- `llm/contextWindows.ts` — model→window map (hosted real; local is a guess → prefer `cascade.contextWindow`).
- `context/compactor.ts` — `resolveCompactConfig`, `estimateTokens`, `olderBoundary`, `maskObservations`,
  `compactIfNeeded` (orchestrates A→B, with the `onDiscard` curation hook).
- `agentLoop.ts` — compaction check before each model call (splices history in place; emits `compacted`).
- `session.ts` — resolves config; wires `onDiscard` (compaction curation) + **session-end curation**
  (`reset`/`dispose`), both opt-in. Removed the old per-turn curation (the firehose).
- `memory/curator.ts` — extraction + **consolidation** (skip semantically-known facts).
- UI — a `🗜 Context compacted` marker; settings `cascade.contextWindow` / `compactRatio` / `keepRecentRatio`.

## ✅ Test queries (F5)
Set **`cascade.contextWindow: 2000`** (so compaction triggers fast), reload, then:
1. Have 4–6 exchanges (or paste a long file via Read). → a **`🗜 Context compacted`** marker appears, and the
   conversation keeps working — earlier facts survive in the summary.
2. Watch the trace: a `model_request` after compaction is **much smaller**, its first message is the
   `[Earlier conversation compacted…]` summary, recent turns verbatim.
3. With `cascade.autoMemory: true`, after compaction (or New chat) check `/memory` → durable facts harvested
   into archival.

## ✅ Self-check
*What triggers compaction, what's preserved vs replaced, and why a boundary instead of a delete?* → It fires
before a model call when estimated tokens ≥ window*compactRatio. The recent window is kept verbatim; the
older half is masked then summarized into one message. We swap history in place (keep a summary, not delete)
so the model continues seamlessly while the full transcript/trace remain for forensics.

## Pitfalls
- Don't hardcode buffers — ratios scale across model sizes.
- Ollama's usable window is `num_ctx` (often 4k), not the model's trained max — set `cascade.contextWindow`.
- Mask/summarize the OLDER region only; never the recent verbatim window.
- Curate (harvest memory) BEFORE discarding the older chunk, not after.

## Deferred
Microcompaction (per-item), agent-controlled compaction (a compress tool), RAG recall of old turns,
disk-offload of masked output, UPDATE/DELETE consolidation (contradictions), real tokenizer.
