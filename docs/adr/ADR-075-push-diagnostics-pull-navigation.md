# ADR-075 — Push diagnostics, don't pull them; navigation off the weak builder

Status: Accepted (2026-07-24)

## Context

A 96-turn build churned `types.ts`/`App.tsx` blind — trial-and-error on TypeScript types, several *duplicate/no-op*
edits — and never converged. Forensics (this session):

- The churn was **not** source-hunting (the ADR-072 premise). Every re-edit was inside each file's own
  definitions; Grep/`Lsp` navigation would not have helped. It was **compiler-feedback starvation**: the model
  had no idea its edits were wrong.
- Root cause: the Docker sandbox container had vanished (Docker/WSL restart on a system sleep — it's `--rm`, so
  it's removed when it stops). Every `docker exec` returned `"No such container"`. The post-edit type check
  ([postEditCheck.ts]) ran `tsc` **in that dead container**, parsed zero diagnostics from the error string, and
  reported a **false clean** every turn. So the push channel that was supposed to hand the model its type errors
  silently delivered nothing.
- Cross-referenced two established agents: **one PUSHES diagnostics** after every edit (baseline
  diff, new-only, deduped, capped, gated on the model having an action tool) and its LSP tool exposes **no
  diagnostics op** — navigation is pull, diagnostics are push. **A pull-only design fetches everything** via a model-invoked
  `lsp` tool (incl. diagnostics) — which is exactly the "model must remember to ask" failure: our `Lsp` tool saw
  **0 calls across the entire build corpus.**
- Corpus churn-split (49 builds): 6 feedback-starvation, ~7 weak-signal "source-hunting?", 36 no-churn. No clean
  evidence that a Grep/navigation-forcing mechanism is warranted; strong evidence that feedback delivery was
  broken.

## Decision

Adopt the push-diagnostics / pull-navigation split, adapted for a weak local model on greenfield apps:

1. **Diagnostics are PUSH-only.** The post-edit check now **falls back to the in-process `LanguageService`** when
   the sandbox `tsc` output isn't a real run (`No such container` / daemon-down / `is not running`). The model
   gets its type errors even with Docker completely dead — no shell required. (Paired with the DockerSandbox
   self-heal that recreates a vanished container.)
2. **Remove the `diagnostics` op from the `Lsp` tool.** It duplicated the push and could **disagree** with it
   (different scope/moment → two answers to "does my code compile" → thrash). The push-first agent's LSP tool
   omits it too.
3. **Gate the `Lsp` tool OFF the weak builder** (`excludeTools: ['Lsp']`). Navigation (definition/references/
   hover) was **0-used** across the corpus AND is a false-negative hazard: a weak model that fumbles the required
   line/column gets "no references found" — indistinguishable from "genuinely unused" — and can act destructively
   on that false empty. The `LanguageService` **engine stays** (the harness uses it for the diagnostics push).

Not done (deliberately deferred — measure first): a harness **push** of `find-references` when the re-edit gate
fires (the "value lives elsewhere" / Velocarta CTA case). Diagnostics-push does NOT cover it (that case compiles
fine), so it's genuinely separate — but the corpus doesn't show it's frequent, and reliably extracting the
thrashed symbol is fragile. Gate it on a post-fix corpus re-scan: if churn-with-working-feedback persists and is
source-hunting, build it as a PUSH (never rely on the weak model to pull).

## Files

- `packages/core/src/agent/postEditCheck.ts` — dead-container detection → LanguageService fallback.
- `packages/server/src/dockerSandbox.ts` — self-heal a vanished container (exec retry on "No such container").
- `packages/core/src/tools/builtins/Lsp.ts` — navigation-only (definition/references/hover); diagnostics op removed.
- `packages/server/src/projectManager.ts` — builder `excludeTools: ['AskUserQuestion', 'Lsp']`.
- `packages/core/test/postEditCheck.test.ts` — the eval: dead container / daemon-down push the REAL error; a
  working sandbox stays trusted. `packages/core/test/lsp.test.ts` — navigation-only.

## How we'll know it worked

The mechanism is proven by the deterministic eval (dead container → real diagnostic pushed). The end-to-end
proof is a real long build: the re-edit `types.ts`/`App.tsx` churn should shrink because the model now sees its
type errors every turn, and `post_edit_check` should fire (it read 0 in the motivating build — the tell that the
push was dead). If churn persists WITH the push working, the residue is the source-hunting case → then, and only
then, build the references-push.
