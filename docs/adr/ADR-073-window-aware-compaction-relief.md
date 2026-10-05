# ADR-073 — Window-aware compaction relief margin (small-window KV-cache thrash)

Status: **proposed** · 2026-07-24 · refines ADR-039 (plan-driven layered compactor) · **gated on a live 64k measurement**

## Context

The ADR-039 compactor runs its layers cheapest-first and **"stops as soon as history is back under the plan's
`auto` threshold"** (`compactor.ts:45`) — it frees the *minimum*. That is optimal for a large window: it
preserves maximum context and, because a big window has generous headroom, it fires rarely. Measured across 22
product builds at the qwen36 131k window, compaction-thrash (>1 compaction per 3 turns) occurred in **1/22 (5%)**
— a non-issue.

It breaks on a **small** window. The `auto → hard` headroom collapses:

| Window | `auto` | headroom (auto→hard) |
|---|---|---|
| 131k | 98,072 | 10,000 |
| **65k** | 45,875 | **3,000** |
| **32k** | 22,937 | **3,000** |

At 64k there is ~3k of slack. "Stop as soon as under `auto`" lands context *just* under `auto`; one turn's
output + tool-result (~2–3k) pushes it back over → **compaction fires almost every turn.** And every compaction
mutates a token in the *middle* of history → the KV cache is invalidated from that point → a full re-prefill.
On a local KV-cached backend that re-prefill costs real wall-time. This was observed directly: capping qwen36
to a 65k window produced **19–30 compactions and ~25 min of compaction-induced re-prefills** in a single build
(the reason `CASCADE_CONTEXT_WINDOW=65536` was reverted).

Confirmed on three fronts:
- **Code:** the stop-early loop above.
- **Math:** the 3k headroom table.
- **Literature:** context-engineering guidance (TokenPilot arXiv 2606.17016, two 2026 engineering write-ups)
  — *"constant layout mutation shatters prompt prefix continuity, and the resulting pre-fill penalties and cache
  invalidations override any financial savings from text reduction."*

**Hosted frontier agents avoid this two ways** and therefore never need the fix: (1) their auto-compaction
does one *big* summarize of the whole conversation (compact **rarely-but-deeply**), dropping context far below
`auto` so it doesn't re-fire for many turns — the opposite of Cascade's **often-but-gently**; and (2) they run
on a hosted API, so a compaction breaks a *server-side* prefix cache (a $ discount) rather than paying local
prefill wall-time. Both escapes are absent on a local small-window model (e.g. gpt-oss-20b at 64k).

## Decision (proposed)

Add a **relief margin** to the compactor: when the window is **small** (below a threshold) **and** the backend
is a **local KV-cached** one (Ollama), stop compacting only once usage is under **`auto − RELIEF_MARGIN`**, not
merely under `auto`. This makes compaction fire every *N* turns instead of every turn — trading a deeper
per-compaction context loss for far fewer cache-invalidating events, which on a KV-cached backend is the
dominant cost.

- **Strictly gated:** engaged ONLY for `(window < THRESHOLD) && (provider is a local KV backend)`. The
  large-window default (qwen36 at 131k, all hosted providers) is **unchanged** — ADR-039 stays optimal there.
- The margin is sized to a few turns' growth, so it is inert on big windows (where headroom already exceeds it).

## Why still *proposed*, not accepted

The no-overfit rule: this fixes a failure mode that is **5% at 131k and 0% for any current default config.** It
must **reproduce on a real small-window build** (a gpt-oss-20b-at-64k run, thrash visible in Phoenix as
compaction-adjacent full re-prefills) before it flips to accepted — otherwise it is a fix for a problem no one
currently has. Do not implement until that measurement exists.

## Consequences / open questions

- Deeper compaction = more summarization = more context loss per event. On an already-tight 64k window this is
  a real cost; the measurement must confirm the re-prefill savings beat the added context loss (build quality).
- Deeper truth this ADR does not solve: a 64k model doing a 180-turn build wants 100k+ of working context. The
  relief margin makes it *survivable*, not *good* — the real lever for small-window local models remains task
  scope, not compaction tuning.
