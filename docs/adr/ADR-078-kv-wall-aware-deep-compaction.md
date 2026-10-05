# ADR-078 — KV-wall-aware deep compaction (branched: hosted vs constrained)

Status: **Accepted — implemented 2026-07-25** (validation A/B pending: first long constrained build vs the
measured hosted baseline). Deferred to follow-up rungs: post-compact file re-attachment (the FILE LEDGER covers the gap initially) and ingestion-side output caps
(Rung 2).

## The measured pathology (2026-07-25, remote 131k build, trace `fc8cfdf9/builder-…22-09-56`)

The current layered compactor is shaped like the hosted frontier agents': run cheap layers escalating,
**stop the instant usage drops under `auto`**. On a backend with a KV wall (every prefix rewrite = full re-prefill), the economics
invert — and the trace shows it brutally:

| Compaction | Layer | Freed | % of window | Re-prefill it caused | Responses until next compaction |
|---|---|---|---|---|---|
| #1 | collapsed | 8,477 | 6.5% | 38s | 21 |
| #2 | collapsed | **701** | **0.5%** | 45s | **1** |
| #3 | masked | 3,265 | 2.5% | 43s + 44s (cascade) | 6 |
| #4 | collapsed | 2,138 | 1.6% | 43s | (end) |

Median per-turn context growth in that build: **438 tok** (p75 1,088). Compaction #2 paid a **45-second
full re-prefill to free 701 tokens ≈ 1.5 turns of headroom** — and re-triggered on the very next response.
The three consecutive 43–45s misses seen in the cache forensics were compactions #2/#3 cascading.
`summarize` never fired once: the cheap layers always got usage just under `auto`, which is precisely the
disease — minimal disruption per event is the RIGHT objective when a cache break is cheap (a hosted
API: pay once, prefill at datacenter speed) and the WRONG one when each event costs a fixed 40–260s
re-prefill regardless of how little it frees.

**Why hosted frontier agents get away with it:** hosted prompt-caching amortizes differently (cache-write is billed
but fast; the next turn re-warms), windows are 200k, and prefill runs at datacenter throughput. The
strategy is proven *for that regime*. Our local regime (Ollama, hybrid-attention reprocessing, 300–2,200
tok/s prefill, 32–131k windows) has opposite cost structure. One code path cannot serve both — the user's
instinct, and correct.

## External validation

- **TokenPilot** (arXiv 2606.17016) — identifies the identical failure: context compression that mutates
  prompt prefixes "inadvertently triggers severe backend KV cache misses" negating its savings. Their
  fixes: (a) **ingestion-side reduction** (truncate noisy tool output BEFORE it enters context — tokens
  that never enter never need compacting and never break cache), (b) **conservative BATCHED eviction**
  (every B=3 turns, not per-turn — amortize the cache break), (c) **byte-stable prefixes**. Result:
  cache-hit 38.7%→79.2%, 56–87% cost reduction, no accuracy loss.
- **An open-source agent platform's condenser** — on trigger, summarizes a **large fraction** of the
  compressible region in one event (default ratio 0.75) into a structured summary, keeping a pinned head + verbatim tail. One deep
  event, long gap — the amortized shape.
- **MemGPT-style tiered memory** — external memory + retrieval; heavyweight, but validates the "harvest durable facts
  out of context" direction we already have (ADR-074 curation).
- **An open-source coding CLI** (its compression service, read 2026-07-25) —
  the strongest confirmation: the same kind of threshold ladder we use, but on trigger it compresses
  the ENTIRE older history into one structured 9-section state snapshot (requests+intent, key concepts,
  files+code, errors+fixes, problem solving, all user messages, pending tasks, current work, next step) —
  the deep single-shot shape, not cheap-layer nibbling. Three ideas worth adopting outright:
  1. **Post-compact file re-attachment**: after the summary replaces history,
     the N most-recent files (default 5) are RESTORED verbatim into context. This is a stronger antidote to
     the re-read storm than a ledger alone — the files the model is actively editing come back for free,
     without a Read round-trip. Adopt: ledger for the long tail + verbatim restore for the top-N recent.
  2. **`<analysis>` scratchpad, then strip**: the summarizer first drafts chronological reasoning in an
     `<analysis>` block that is deleted before the summary is used — a cheap quality lever precisely for
     WEAK models writing summaries (our constrained-mode case). Adopt outright.
  3. **Failure circuit breaker** (3 consecutive failures): consecutive summarize failures stop
     auto-compaction attempts until a successful forced pass resets it — prevents a wedged local backend
     from paying a failed side-query every turn. Adopt.
  Also notable: compaction-input slimming (media → placeholders before the summarize side-query).

## Decision (proposed): branch the compaction PLAN by backend economics

`CompactionPlan` gains `mode: 'hosted' | 'constrained'`.

- **hosted** — current behavior, byte-for-byte (proven by hosted frontier agents; frontier APIs, server prompt caching).
- **constrained** — selected when the provider is local/native-Ollama, or window < 64k, or explicitly set.
  Same layers, inverted stopping rule: **compact rarely, compact DEEP.**

### Constrained mode: calculated thresholds, not ratios (the user's requirement)

Both numbers derive from **live-measured turn growth** (we already collect `inputTokens` per response;
the session keeps a running p75 of per-turn deltas):

```
turnGrowth  = p75 of inputTokens deltas this session (fallback 1,200 tok before 5 samples)
trigger     = window − max(summaryReserve + wireOverhead, K_TRIGGER × turnGrowth)   // K_TRIGGER = 8
target      = min(window × (1 − FREE_TARGET), trigger − 2×turnGrowth)                // FREE_TARGET = 0.45
floor:  target ≥ keepRecentTokens + summaryReserve   // tiny windows: clamp, never degenerate
```

- **trigger** fires when fewer than ~8 turns of headroom remain — early enough that the summarize
  side-query itself still fits comfortably in the input budget.
- **target** demands **≥45% of the window free after the event** — at p75 = 1,088 tok/turn on a 131k
  window that buys **~50 turns** between compactions (measured today: 1–21 responses).

### Constrained mode: one event, multi-step, to target

On trigger, in a single compaction event (one prefix rewrite, one re-prefill):
1. Run **all** cheap layers to exhaustion (collapse → mask → microcompact → snip) — do NOT stop at `auto`.
2. **Always summarize** the older region (everything before the keepRecent boundary) — no `canHelp` gate;
   in constrained mode summarize is the point, not the fallback.
3. If still above target (pathological single results), extend the older boundary toward the recency
   shield and re-run mask/snip once.

One 60–120s summarize + one ~45s re-prefill buying ~50 turns beats four shallow events at 45s each buying
1–21 turns — and the measured build would have gone from 4 compactions + 5 cascaded misses to **one**.

### Quality preservation (the "without degrading quality" requirement)

- Recency shield + verbatim keepRecent tail: unchanged.
- Pinned PLAN.md + static system prompt: unchanged (prefix stays byte-stable between events — TokenPilot's
  prerequisite, already true in Cascade).
- ADR-074 curation harvests durable facts from the discarded region before the summary replaces it: already
  wired (`onDiscard`); deep compaction gives it MORE to harvest, and post-compaction recall can resurface it.
- **Structured summary contract** (new, constrained-mode prompt): the summary MUST contain
  (a) a **file ledger** — every file created/modified with one-line purpose + key exports/props,
  (b) decisions made and WHY, (c) unresolved errors + next steps, (d) user requirements verbatim.
  Rationale: the main quality risk of deep compaction is the **post-compaction re-read storm** (the model
  re-Reading files it forgot — refilling the window and wasting turns). The file ledger is the antidote;
  re-read count after compaction is the quality metric to watch in the A/B.
- Tail note injected post-compaction: "history was summarized; trust the summary + PLAN.md; re-read a file
  only to edit it."

### Rung 1b — wire-accurate token accounting (phantom-thinking fix)

`estimateTokens` counts stored `thinking` blocks (`b.thinking.length`) — but **neither wire path ever
replays thinking** (native `toNativeMessages` sends `textOf(blocks)` only; `/v1` never sends reasoning
back; measured earlier: replay-vs-strip ≈ 30 tokens either way). So compaction accounting counts
**phantom tokens the model never sees**: a chatty-thinking model at ~500 chars/turn × 90 turns ≈ 11k
phantom ≈ 8% of a 131k window — the trigger fires early and the older-region/boundary math is skewed.
Fix: `estimateTokens` gains a wire-accurate mode that **excludes thinking** for trigger/threshold/boundary
math. Two deliberate exceptions keep counting it: (a) the summarize-fit check — old thinking IS part of
the summarize call's real input (`(thinking)` lines feed the summary, and should keep doing so); (b) the
curation harvest slice. Free trigger-delay on top of the deep-compaction redesign.

### Rung 2 (separate, cheap, TokenPilot's biggest lever): ingestion-side caps

Prevention beats cure: cap noisy tool results AT ENTRY (Bash/Browser/test output → head+tail excerpt,
~600/400 style) instead of letting 20k-token logs enter and be masked later. Slows growth (delays trigger)
AND keeps the prefix stable (no later mutation of that message). Cascade already has `readCapChars` for
Read; this extends the idea to command output. Small, independent change — measure separately.

## Edge cases (enumerated)

1. **Summarize-must-fit**: triggering with ~8 turns of headroom guarantees the older region + summary
   prompt fit the input budget; if a single giant result blocks it, mask/snip first (step 1 handles this).
2. **Summarize failure / timeout** (wedged local backend): fall back to exhaustive cheap layers only
   (still deeper than today), keep the same recover/retry hooks; never leave the loop stuck.
3. **Tiny windows (8–16k)**: the floor clamp keeps `target ≥ keepRecent + reserve`; FREE_TARGET yields to
   the floor (you cannot free 45% of a window that keepRecent occupies).
4. **Overflow/force path**: unchanged — already compresses as hard as possible.
5. **Turn alignment**: existing `turnAlignedBoundary` prevents splitting an assistant/tool_result pair.
6. **Weak model writes the summary**: structured headings + length cap; same recency shield means recent
   work is never entrusted to the summary at all.
7. **Double-trigger races**: post-event usage ~55% makes the measured 1-response re-trigger structurally
   impossible; belt-and-braces, a per-submit "one deep compaction per N turns" latch.
8. **Adaptive-growth cold start**: before 5 usage samples, the fallback (1,200 tok/turn) over-reserves
   slightly — safe direction.
9. **Curation double-harvest**: onDiscard receives each older slice once per event — dedup already handled
   by curator similarity gate (≥0.85 NOOP).

## Validation plan (no-overfit gate)

A/B on the long game-build prompt (the one currently queued), same model (`qwen36-agentic-iq4`):
- **Control**: current mode. **Treatment**: constrained mode.
- Success criteria: compactions/build ≤ 2 (vs 4), total re-prefill minutes ↓ ≥50%, **no increase** in
  post-compaction re-reads, churn, or post-edit-check failures; build passes its smoke test.
- Fail → tune FREE_TARGET/K_TRIGGER once; still fail → keep hosted mode default and re-examine.

## Files (when approved)

- `compactionPlan.ts` — `mode`, calculated trigger/target, live turn-growth tracker plumbing.
- `compactor.ts` — constrained stopping rule (layers to exhaustion + unconditional summarize to target),
  structured summary prompt variant, post-compaction tail note.
- `session.ts` — per-turn growth measurement (from existing usage events) fed into the plan.
- `projectManager.ts`/factory — mode selection (native-Ollama/local ⇒ constrained; hosted ids ⇒ hosted).
- Tests: threshold math (incl. tiny-window clamp), one-event-to-target behavior, summarize-failure
  fallback, re-trigger latch.
