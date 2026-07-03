# ADR-049 — The verification gate: "done" is not accepted until verified (or explained)

> **Status:** implemented. Third rung of the measured weak-model ladder (ADR-047 → 048 → this), and a
> deliberate step BEYOND frontier-first harnesses: they ask for verification in prompt text; Cascade enforces it as a
> loop invariant.

## Context

After ADR-048 unblocked the 3B's tool arguments, the eval's dominant failure class became **`false_done`**
— and at BOTH ends of the curve: 7/10 on `llama3.2:3b`, and both 35B polyglot failures (`zebra-puzzle`,
`complex-numbers`) were also `false_done`. The pattern: the model edits files, announces success, and never
runs anything that could contradict it. Our system prompt already says verify-before-done (ADR-037, kept in
every tier) — prompt text demonstrably does not hold a weak model to it, and even strong models skip it
under long-context pressure.

## Decision

A structural gate at the loop's TERMINAL branch ([agentLoop.ts]), mirroring the ADR-034 reminder pattern —
pure helpers in [verifyGate.ts]:

- The loop folds every executed batch into one bit, `editedSinceVerify`: a **successful** file-mutating
  call (`Write/Edit/MultiEdit/NotebookEdit`) sets it; any **verification command** run clears it (Bash
  matching `tests?|--test|vitest|jest|mocha|pytest|tsc|npm t` — running a RED suite still counts: its
  output feeds back and drives the next edit, which is the loop working).
- When the model produces a terminal answer while `editedSinceVerify` is set, the loop does NOT accept it:
  it traces `verify_gate`, appends one `<system-reminder>` user turn — *run the project's tests and report
  the result, or state explicitly why verification is not possible* — yields a status event, and continues.
- **Once per submit, budget-respecting, opt-outable.** The second terminal answer is accepted
  unconditionally ("no tests exist here" is a legitimate answer); the nudge is skipped at the maxTurns
  boundary; `verifyGate: false` (LoopDeps + SessionOptions) opts out.

Why this can't loop or annoy: the gate arms only when unverified file edits exist, fires at most once,
and never overrides the model — it buys exactly one turn of honesty.

## Consequences

- **Tests:** 6 (4 through the REAL loop + Write tool: nudge-once/no-edits/edit+test/opt-out; 2 pure-helper
  incl. failed-writes-don't-arm and red-suite-clears). The tracer test now documents the gate in the
  canonical event skeleton. Suite: 216 green.
- **Eval delta:** recorded in [EVAL-BASELINE.md] (3B class shift + agentic no-regression gate).
  Expectation set honestly: on a 4k-window 3B the nudge may not convert failures into solves — the measure
  of success is `false_done` shrinking (replaced by honest verification attempts), plus any strong-model
  wins on pressure tasks.
- **Beyond the usual design:** frontier-first harnesses have no completion invariant — their verify-before-done
  lives in prompts and model quality. A harness-level gate is the kind of structural reliability a weak-model-first design
  needs and a frontier-first design never built.
- **Deferred:** project-aware verification detection (read package.json scripts to know THE test command);
  counting a `Lsp diagnostics` pass as verification; gating on todo-list completion (pairs with ADR-034).

[verifyGate.ts]: ../../packages/core/src/agent/verifyGate.ts
[agentLoop.ts]: ../../packages/core/src/agent/agentLoop.ts
[EVAL-BASELINE.md]: ../EVAL-BASELINE.md
