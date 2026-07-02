# ADR-042 — MultiEdit: atomic multi-edit of one file (CORE-PARITY §B: MultiEdit)

> **Status:** accepted; **implemented.**

## Context

A weak model changing one file in several places today fires **N separate `Edit` calls**. Each is a chance for
a failed-edit retry loop, and a mid-sequence failure leaves the file **half-edited** — a state the model then
has to detect and unwind. The established fix is an `edits` array on the file-edit tool: all edits applied to
an in-memory copy, written only if every one succeeds.

## Decision

A **`MultiEdit`** tool that applies several exact-substring edits to one file **atomically**. The algorithm
follows that established core and fuses it with the invariants we already made stronger (ADR-032 freshness,
ADR-033 confinement, CRLF-normalize) — which is exactly what a weak model on Windows / in a sandbox needs:

1. **Confine** the path (`resolveInProject`, ADR-033); **read + CRLF-normalize**; **read-before-edit freshness**
   (ADR-032). The freshness guard + cache refresh are now a **shared `editCore.ts`** used by both `Edit` and
   `MultiEdit`, so the two can never drift.
2. Apply edits **in order** to an in-memory `working` copy (edit N sees the file as 1..N-1 left it):
   - **Collision guard** — N's `old_string` (trailing-newline-trimmed) must NOT be a substring of an earlier
     edit's `new_string`, else it would match text that edit just inserted (a subtle, established correctness rule).
   - **Match rule** — `replace_all:false` (default) requires `old_string` to appear **exactly once** (our
     stricter contract vs the usual first-match); `replace_all:true` requires ≥1 and replaces all (the rename win —
     the back half of `Lsp references → MultiEdit`).
3. If nothing changed → error. Otherwise **write once**, refresh the freshness cache, return **one combined
   diff** card. Every failure **names the edit index** and leaves the file byte-for-byte untouched.

**Correctness fix (applied to both tools):** replacement uses a **function replacer** (`() => new_string`) so a
`new_string` containing `$&`/`$1`/`$$` is inserted **literally** rather than mis-expanded as a regex replacement
pattern — a latent bug in the single `Edit` too, now fixed.

Scope: `old_string:''` (whole-file create) is intentionally NOT supported — that's `Write`'s job; MultiEdit is
for multi-point edits of an existing file.

## Consequences

- One atomic operation replaces N fragile Edit calls; a weak model gets **one precise, self-correcting error**
  instead of a half-applied file to clean up.
- Completes the **rename/refactor workflow**: `Lsp references` (find every use) → `MultiEdit replace_all` (change
  them) — semantic + atomic.
- `Edit` and `MultiEdit` share their freshness invariant, so ADR-032 behavior stays consistent across both.

## Verification

Headless (8/8): sequential application (`a b c` → `X Y c`); **atomicity** (a failing edit #2 leaves the file
exactly `a b c`, nothing written); collision guard; non-unique-without-replace_all error; `replace_all` rename;
**`$`-literal** replacement; read-before-edit freshness enforced; path outside the project rejected. Full suite
(155) green — the shared-helper refactor didn't regress `Edit`.

## Follow-ups

- `Lsp rename` op that computes the `MultiEdit` from `references` automatically.

[editCore.ts]: ../../packages/core/src/tools/editCore.ts
