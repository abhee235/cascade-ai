# ADR-045 — Bash execution hardening: timeout + honest head/tail truncation (CORE-PARITY C4)

> **Status:** accepted; **implemented + tested.**

## Context

`Bash` is the load-bearing tool of a coding harness — the model runs builds, tests, installs, and git through
it. Ours ([builtins/Bash.ts]) was ~74 lines vs ~1144 in a mature frontier agent, and two of the gaps were not
"nice to have" but *run-killers* for a weak local model:

1. **No timeout.** The only kill switch was the user's Stop button. A command that waits for stdin (a missing
   `-y`, an interactive prompt) or loops forever would **hang the entire turn** with no recovery — the single
   most common way an autonomous run dies.
2. **The truncation lied.** The code kept the **head** (`out.slice(0, MAX)`) while the description promised the
   **tail**. For `npm test` / `tsc` / a crash, the signal the model needs — the failure summary, the stack
   trace, the exit line — is at the **end**. We were discarding exactly the part that lets the model
   self-correct, and mislabelling it.

Common choices in mature agents, for reference: default **120 s** timeout, hard max **600 s**; output capped at
30 k chars keeping the **head** only; long commands **auto-background** into a background-shell-task
subsystem.

## Decision

- **Timeout** — a `timeout` input param (ms, default **120 000**, hard max **600 000**, clamped). One
  `AbortController` drives the child and trips on **either** the timer **or** the session's Stop; a `timedOut`
  flag disambiguates them. The *same* controller signal feeds **both** execution paths (host `spawn` and
  `sandbox.exec` — both already accept an `AbortSignal`), so timeout is uniform across the extension and the
  web. On expiry the result is **actionable**, not a silent kill:
  `[timed out after 120s — the command was killed. Rerun with a larger `timeout` (up to 600000 ms) or narrow
  the command.]` — so the model recovers by ADR-007 error-as-feedback (rerun with more time) rather than
  needing a background subsystem.
- **Truncation, done right (better than head-only)** — a `BoundedOutput` accumulator keeps the **first `HEAD` (12 k)
  and last `TAIL` (15 k) chars** of the stream regardless of total size (a 5 GB `cat` can't blow memory or the
  context window), dropping the middle with a `... [N chars omitted] ...` marker. Tail-favoured because
  failures land at the end. Plus a **per-line cap** (`MAX_LINE` = 2 k) so one minified/base64 line can't
  dominate the view. Works for a live host stream (many `push`es) and the sandbox path (one `push` of the whole
  string) with one code path.
- **Description** — corrected to describe the real head+tail behaviour and the timeout, tier-sized per ADR-037
  (the timeout + truncation notes are load-bearing enough to stay at `full` and `lean`; `minimal` keeps only
  the damage-preventing rules).

**Explicitly deferred (not silent):** background tasks (`run_in_background` + auto-background +
BashOutput/KillShell) — the background-shell-task subsystem above. In the web builder the long-lived dev
server is already run by the **preview system**, so the model's actual Bash usage (install/test/build/git) is *finite* and covered by a
generous timeout + the "rerun with more time" self-correction. This is the natural follow-up (it also overlaps
CORE-PARITY §B "TaskCreate…"), not a hidden gap. Also deferred: the command-prefix **permission** classifier
(that's A5), git-operation tracking, and image output.

## Consequences

- A hung command now dies at its deadline with a message the model can act on — no more turn-killing hangs.
- A failing command's **end** (the part that explains the failure) survives truncation, so the model can fix
  the cause instead of guessing from the head. Memory + context are bounded regardless of output size.
- One `AbortController` + one `BoundedOutput` serve both the host and the sandbox, keeping the tool small.

## Verification

Headless (`bash.test.ts`, 13/13): a 10 s command with `timeout:300` is killed in <3 s with `timed out after
300ms` + the recovery hint (and is distinguished from `[aborted]`); the sandbox path honours the timeout via
its signal; 40 k of output keeps `line0` **and** `line4999` with a `[N chars omitted]` marker and stays under
30 k; a 5 k single line is shortened to `[+3000 chars]`. Full suite 182 green. Live-verified against
gpt-oss:20b in the web builder.

[builtins/Bash.ts]: ../../packages/core/src/tools/builtins/Bash.ts

