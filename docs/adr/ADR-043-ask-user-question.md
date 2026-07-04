# ADR-043 — AskUserQuestion: structured mid-task questions (CORE-PARITY §B: AskUserQuestionTool)

> **Status:** accepted; **fully implemented + tested** — engine (tool + protocol + scheduler park + session
> round-trip + tier-sized description) AND both frontend UIs (web QuestionCard; extension QuestionCard +
> `answer` bridge, 2026-07-04). Abort-while-parked race fixed at the session seam (see addendum).

## Context

A weak local model **guesses wrong on ambiguity far more than a frontier model** — it picks a library, an
approach, a config the user didn't want, then builds on it. The highest-leverage fix (faculty E in
`tool-faculties.md`) is a structured **"ask instead of assume"** channel it can use MID-task, without stopping,
when it's genuinely blocked on a decision only the user can make. An ask-the-user tool is the established way;
the tool's *effect* is a round-trip to the user, so it must **pause the agent loop** until the answer arrives.

Cascade already has exactly that pause primitive: the **permission `ask`** flow — the scheduler yields a
`permission` event and `await`s `perm.request(id)`, which the session resolves when the frontend calls
`respondPermission`. `gate.ts` even states user-interaction pausing belongs in the scheduler. So AskUserQuestion
is the same shape, reused.

## Decision

- **Tool** ([builtins/AskUserQuestion.ts]) — schema follows the established shape (`questions[1..4]` of `{question,
  header≤12, options[2..4]{label,description,preview?}, multiSelect}`) with a uniqueness refine (distinct question texts
  + option labels). `requiresUserInteraction() = true`; read-only + concurrency-safe. Its `call()` only runs when
  there's **no** interactive channel (headless) — returning a clear "proceed with a default" error, so the loop
  never hangs.
- **Round-trip seam** — new `AskController` on `ToolContext` (`ask.request(id): Promise<Answers>`), same shape as
  `PermissionController`. Protocol: `question`(out, engine→UI) + `answer`(in, UI→engine). Session mirrors the
  permission plumbing: a `pendingAnswers` map + `respondQuestion(id, answers)` that resolves the parked promise.
- **Scheduler** ([scheduler.ts]) — for a tool that `requiresUserInteraction()` **and** has a channel: yield
  `toolStart` + `question`, `await ctx.ask.request(id)` (BLOCKS), then feed the formatted answers back as the
  tool_result. `call()` is skipped. Subagents get **no** `ask` (they run autonomously) → their AskUserQuestion
  hits the no-channel path and defaults.

## Beyond the common design

- **Tier-sized description** (ADR-037): full / lean / minimal by window (the usual one is static). The load-bearing
  conventions ("Other" is automatic; recommend-first `(Recommended)`) are kept at **every** tier.
- **Weak-model nudge baked into the description:** *ask only when genuinely blocked — investigate the code
  first; don't offload decisions you can make or discover yourself* — countering a weak model's tendency to
  over-ask (or ask what's answerable from the repo).

## Consequences

- The model can resolve ambiguity with the user mid-task instead of guessing; the whole pipeline (scheduler
  park, session resolve, protocol) reuses the permission mechanism, so there's one pattern for "pause the loop
  for the user", not two.
- Headless / non-interactive runs degrade gracefully (default + state the assumption).

## Verification

- Headless (3/3): the loop yields `question` and **parks** on `ctx.ask` — the answer is resolved only *after*
  the event is observed, and `request` is called with the tool-use id; the answer becomes the `q1` tool_result
  (`… → Postgres`) and the model's final reply reflects it. No-channel run returns the error and does **not**
  hang. Description is tier-sized + registered; the uniqueness refine rejects duplicate option labels. Full
  suite (158) + server typecheck green.
- (Follow-up) live: once the UI lands, drive an ambiguous task on `coding-qwen36` and confirm it asks rather
  than guesses.

## Follow-ups

- ~~**Frontend question UI** (web card with options + an always-present "Other" free-text; extension equivalent) →
  `answer` inbound → `session.respondQuestion`. The server relays `question`/`answer` like it does `permission`.~~
  **DONE (2026-07-04):** web (QuestionCard + wsServer `answer`) and the extension (`QuestionCard` in `ui/App.tsx`,
  `answer` inbound in `CascadeViewProvider`, answered read-only record in the transcript). Before the extension
  bridge, a question in VS Code parked the loop with no UI able to answer — a guaranteed hang, since the tool is
  a builtin advertised in every session. Verified by driving the built webview bundle in real Chrome (12 checks:
  render, submit gating, radio/checkbox semantics, Other join, exact `answer` payload, record rendering,
  new-chat clearing).
- `preview` rendering (side-by-side option compare) — schema field is already there.

## Addendum (2026-07-04): abort must observe the park — a race, not a drain

`session.abort()` drained parked *permissions* but not parked *answers*: Stop during a question hung the loop
forever, in every frontend. Draining `pendingAnswers` in `abort()` is NOT sufficient — the regression test
caught a race: the scheduler yields the `question` event and only *then* awaits `ask.request(id)`; a consumer
that calls `abort()` on receiving the event does so while the generator is still suspended at the yield, so the
map is empty and the drain no-ops. The fix: `ask.request` itself watches the turn's abort signal (resolves `{}`
immediately if already aborted, or on the `abort` event). The test is honest — it hangs without the fix.

[builtins/AskUserQuestion.ts]: ../../packages/core/src/tools/builtins/AskUserQuestion.ts
[scheduler.ts]: ../../packages/core/src/tools/scheduler.ts
