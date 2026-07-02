# ADR-044 — Plan-mode flow: EnterPlanMode / ExitPlanMode (CORE-PARITY §B)

> **Status:** accepted; **implemented + tested.**

## Context

For a non-trivial implementation task, a weak local model that dives straight into edits will happily build the
*wrong thing* on a guessed approach. The established fix is **plan mode**: `EnterPlanMode` restricts the
agent to read-only exploration, the model designs an approach, and `ExitPlanMode` presents it and **requests the
user's approval** before any code is written. `ExitPlanMode` *is* the approval gate — the model must not use
AskUserQuestion to ask "is my plan ok?".

Cascade already had the two hard pieces: the **`plan` permission mode** (`gate.ts` — denies writes, allows
reads) and the **AskUserQuestion pause + QuestionCard UI** (ADR-043). So this ADR is almost entirely reuse.

## Decision

- **EnterPlanMode** ([builtins/EnterPlanMode.ts]) — no params; `call()` saves the current permission mode to
  `state.priorMode` and sets `state.mode = 'plan'`. Read-only (auto-allowed). Now every write/command is denied
  by `checkPermission` and only reads pass.
- **ExitPlanMode(plan)** ([builtins/ExitPlanMode.ts]) — `requiresUserInteraction`, so it runs through the
  **same scheduler round-trip as AskUserQuestion** and renders in the **same QuestionCard** (no new UI):
  `toQuestions` presents the plan with `[Approve, Revise]` options; `applyAnswers` — on **Approve** — restores
  the **prior** mode (`state.priorMode`) and reports "writes unlocked, implement now"; on **Revise** (or
  free-text feedback via "Other") it stays in plan mode and tells the model to iterate.
- **Scheduler generalization** ([scheduler.ts]) — the ADR-043 interactive path now calls `tool.toQuestions(input)`
  + `tool.applyAnswers(input, answers, ctx)` instead of hard-coding AskUserQuestion's shape, so both tools share
  one mechanism (and `applyAnswers` can act — here, flip the mode).
- **Plan-aware denial** — a write blocked *by plan mode* now returns a **plan-specific** tool_result ("you are in
  PLAN MODE … finish planning and call ExitPlanMode"), not the misleading "the user declined this action" — so a
  weak model doesn't misread it as a filesystem error and retry.

**The `priorMode` subtlety (why it matters):** the web runs `bypass` mode. Restoring to a hardcoded `default`
would make post-approval writes *prompt* — and the web has no permission UI, so they'd hang. Saving/restoring
the prior mode returns the web to `bypass` (writes just run) and the extension to `default`.

## Consequences

- The model can get sign-off on its approach before writing code — a real weak-model win (no more building the
  wrong thing), with **zero new UI** (the QuestionCard handles approval) and no new pause mechanism.
- One interactive-tool mechanism (`requiresUserInteraction` + `toQuestions`/`applyAnswers`) now serves both
  AskUserQuestion and ExitPlanMode; adding another human-in-the-loop tool is a few lines.

## Verification

Headless (2/2): EnterPlanMode → a `Write` is **blocked** (plan-specific message, file not created) → ExitPlanMode
presents the plan → **Approve** restores the prior mode and the *next* `Write` **succeeds**; the **Revise** path
keeps the session in plan mode with the write still blocked and an actionable "did NOT approve" result. Full
suite (174) + server typecheck green.

## Follow-ups

- Render the plan as markdown in the QuestionCard (currently plain text in the question).
- A plan-mode system-prompt section while in plan mode (some agents inject one) — the tool descriptions + the
  plan-specific denial already steer the model; this is polish.

[builtins/EnterPlanMode.ts]: ../../packages/core/src/tools/builtins/EnterPlanMode.ts
[builtins/ExitPlanMode.ts]: ../../packages/core/src/tools/builtins/ExitPlanMode.ts
[scheduler.ts]: ../../packages/core/src/tools/scheduler.ts
