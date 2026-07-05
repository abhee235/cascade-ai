# ADR-051 — Verify-gate hardening for the weak tier (the false_done wall)

> **Status:** implemented + **measured** (2026-07-05, batch 7). hermes3:8b A/B on 10 tasks: solves flat
> (1/10 → 1/10) but the CLASS SHIFT is the designed outcome — `false_done` **6 → 2**, `no_tool_use` 2 → 0,
> converting into `wrong_code` 0 → 5: the model now RUNS the declared check and sees it fail instead of
> silently claiming success. `wrong_code` is the model-capability wall the harness deliberately does not
> fake past. Strong tier: **12/12, zero added turns** (the inert-path proof, measured). Consumers wired:
> eval runner (task.check), web builder (`npm run build`), VS Code setting (`cascade.checkCommand`).

## Context — the measurement that names this rung

`false_done` — the model ends its turn claiming completion without ever running a check — is now the
**dominant weak-tier failure class**, and it has appeared at BOTH ends of the curve:

- `prose-fallback-3b`: 7×, `invalid-args-3b`: 7×, `json-repair-3b`: **5×** `false_done` out of 10 tasks —
  the classifier note is always the same: *"finished without ever running the tests"*.
- Both Tier-2 polyglot failures on the 35B were also `false_done` (recorded in ADR-048).
- Every parsing/args rung we ship (047, 048, item 4) *increases* the share of `false_done` — unblocking
  execution reveals stopping-without-verifying as the true ceiling.

ADR-049 already ships a verify gate. It demonstrably does not hold the 3B. Trace-verified gaps:

1. **It only fires on edits.** `editedSinceVerify` gates the refusal — a model that explored, made ONE
   tool call, and answered prose never trips it (the majority of the 3B's false_done rows: 1–2 tool
   calls, then a confident answer).
2. **One strike, then accept.** The 3B ignores a single nudge the same way it ignored the delegation
   nudge pre-re-anchor (item-4 lesson: reminders that don't re-anchor get answered or ignored).
3. **The nudge is abstract.** "Verify your changes" assumes the model can DERIVE the check command.
   Measured all day: weak models execute *directives* ("run X now") far better than abstractions.

## Decision (design)

1. **Re-anchor the verify nudge** (same fix as the delegation nudge, item 4): end with "This is a
   background note, NOT a new request — run the check now, then continue."
2. **Name the exact command.** Resolution ladder for the canonical check: SessionOptions.checkCommand
   (eval fixtures / builder pass it) → package.json `test` script → known runners present in the repo
   (vitest/jest/node --test). The nudge becomes: *"You edited files but never verified them. Run
   `npm test` now and report the result."* When nothing resolves, fall back to today's abstract wording.
3. **Two strikes, not one.** `verifyGate: { strikes: 2 }` (default 2 for sessions with a resolved check
   command, 1 otherwise — don't loop a chat turn forever). A red check run still counts as verifying
   (ADR-049 rule preserved: honesty about failure beats silence).
4. **The no-edit hole stays open — deliberately.** Refusing terminal answers on read-only turns would
   fire on every legitimate Q&A chat. Instead, the no-edit false_done case is addressed by (2) only when
   the TASK carried a check command (eval/builder) — i.e., contexts that declared "done means the check
   passes" get held to it; chat contexts don't.

## Measurement plan

- 3B probe (same 10 tasks): expect `false_done` count to drop; any conversion to `wrong_code`/`loop_stall`
  is PROGRESS (the model is at least exercising the check).
- Strong-tier full gate: no regression (the gate only adds turns when a check command resolved and the
  model skipped it).

## Non-goals

- Auto-RUNNING the check for the model (harness-executes-then-injects-result): tempting, but it teaches
  the model nothing and silently burns turns on projects with slow suites. The model must own the call.
- Any notion of "the harness decides the task is done". The gate only ever REFUSES-and-nudges; the model
  always makes the final claim.

[ADR-049]: ./ADR-049-verify-gate.md
[ADR-048]: ./ADR-048-input-normalization.md
