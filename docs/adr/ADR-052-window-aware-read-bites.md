# ADR-052 — Window-aware Read bites (one bite must never exceed the plate)

> **Status:** DRAFT — design agreed 2026-07-04; implementation queued in the next batch (per the new
> batch-then-eval method). Root cause of the survival-wipe cascade, traced across every longctx failure.

## Context — the measured failure

Read refuses whole-file reads over a flat `MAX_CHARS = 50_000` (~12.5k tokens) and teaches offset/limit.
That cap is sized for big windows. On an 8k-token window, the usable content budget after system prompt +
tool schemas (~4k tokens, measured on the wire in ADR-039 rule 5) is ~4k tokens ≈ 16k chars — so a single
"legal" 19k-char read (the changelog file) instantly overflows the whole window. Every longctx failure
today opened exactly this way: whole-file read(s) → window explodes → survival compaction amputates the
just-read content → the model re-reads → repeat until the clock dies.

## Decision (design)

1. **Derive the bite cap from the session's window.** The compaction plan already knows the window
   (`toolResultMaxChars` is plan-derived). Read gets a session-supplied cap: on big windows it stays
   50k (strong models unaffected — by construction, the no-overfitting rule); on small windows a
   whole-file read above ~¼ of the usable content budget errors instead.
2. **The error TEACHES the exact next call.** Not "file too large" but: *"this file is 214 lines
   (19,032 chars); your window fits about 60 lines per read — call Read again with offset: 1, limit: 60,
   then continue with offset: 61."* The model doesn't need judgment; the error hands it the calls.
3. **Explicit offset/limit is always allowed** (the model's deliberate choice, unchanged today), but the
   RESULT is still subject to the same cap — a limit:2000 request on an 8k window gets the same teaching
   error rather than a silent overflow.
4. **Plumbing:** ToolContext gains a `readCapChars?: number`; the session computes it from the plan once
   (e.g. `clamp(plan.toolResultMaxChars * 6, 6_000, 50_000)`) and threads it through. Tools without a
   session (headless smokes) keep the flat 50k.

## Why this beats compaction-side fixes alone

The compactor's shield/survival rules (ADR-039) manage the damage AFTER an oversized bite; this prevents
the bite. Together: reads stay window-sized, so the recency shield actually has room to protect them, and
survival mode becomes the rare path instead of the default at 8k.

## Measurement plan (batched)

Rides in the next batch eval: hermes3:8b before/after on the 10 tasks + strong-tier gate (expect: fewer
compactions per longctx task, fewer re-reads, changelog wall-clock down; strong gate unchanged).
