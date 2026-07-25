# ADR-072 — Weak-model tool routing: Grep/Lsp for source-finding + a re-edit breaker

Status: **accepted** · 2026-07-24 · builds on ADR-058 (read-loop gate), ADR-056 (mandated-not-routed)

## Context

A corpus sweep of **22 product builds** (the `_temp/trace-doctor` analyzer over `cascade-projects/*/traces`),
run specifically to separate *frequent harness gaps* from *one-build flukes* (the anti-overfit gate), found a
chronic tool-routing failure — not an anecdote:

| Signal | Frequency |
|---|---|
| **Lsp used 0×** | **22/22 (100%)** |
| **Grep used 0×** | **18/22 (82%)** |
| A file edited ≥5× (churn) | 12/22 (55%) |
| Read ≥ 3× the edits (brute-force reading) | 5/22 |

`Lsp` is advertised and **functional** (an in-process TypeScript service — the same one that already produces
the post-edit-check diagnostics, no external server needed), yet it is used *zero times across the entire
corpus*. The model brute-force **Read**s files (75× in one 180-turn build) instead of searching, and when a
change "doesn't take" it re-edits the same file rather than tracing to the real source — the Velocarta build
re-diagnosed one CTA-colour issue **three times**, editing the call site while the colour lived in the theme.

Compared with a frontier-model coding agent: its debugging "system" is three prose principles
(read-before-change, diagnose-before-retry, root-cause-not-bypass) plus read-only explore/verifier subagents.
Crucially it has **no explicit "look up the definition before using it" rule and no code-level loop-detector** —
it closes those failure modes with *model strength*. Cascade's prompt already states the same principles
(systemPrompt.ts: read-before-edit, prefer-Grep-over-Bash). So the gap is **not prompt content — the
weak model does not act on the tool guidance it already has.** This is the exact pattern ADR-056 established
for skills ("weak models route poorly on categories, so the two always-needed skills are *mandated*, not
routed"): the same is now proven true of *tools*.

## Decision

Two evidence-gated changes; the corpus frequencies are the justification, not a single build.

1. **Situation-triggered routing (prompt).** Add to `BUILDER_BEHAVIOR` a short rung telling the model *when* to
   reach for search vs re-reading (distinct from the existing "prefer dedicated tool over Bash"):
   - To find WHERE a type/symbol/style/token/value is *defined*, use **Grep** (text) or **Lsp** (definition /
     references / hover) — never re-read files hunting for it.
   - When a change doesn't take effect (a colour/style still looks wrong after your edit), its source is
     elsewhere: Grep for the token/class and fix it at its **definition**, not the usage site.

   These are general software-engineering practice (frontier agents have equivalents), so they are not qwen-overfit; they
   make explicit what a strong model infers.

2. **Re-edit breaker (harness gate).** A sibling of the ADR-058 read-loop gate: the Nth successful Edit/Write of
   the *same* file with no verifying check passing in between fires a one-shot `<system-reminder>` pointing the
   model at Grep/Lsp to find the real source before editing again. Threshold set higher than the read gate
   (edits are more often legitimately iterative), and the nudge is *advisory* — harmless if the churn was real
   feature-work, corrective if it was thrash. Inert-by-default: a model that doesn't thrash never sees it.

## Consequences

- Inert for strong models — they already route to Grep/Lsp and don't thrash, so the gate never fires and the
  prompt lines are neutral. The strong-gate diff (eval bench, same task set) is the proof it doesn't regress.
- The two flukes the corpus explicitly de-prioritised (fix-loop rounds median 2 — Velocarta's 36 was a
  heavy-app outlier; the `photoFor` API-guessing — n=1, template-specific) are deliberately NOT addressed here.
- Follow-up worth measuring: if Lsp stays unused even after the routing rung, the tool itself may be
  mis-described for the model (its schema/examples), which is a separate, cheaper fix than the routing prose.
