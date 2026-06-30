# ADR-034 — TodoWrite robustness: durable store + state-aware reminder + invariant enforcement

## Context

We shipped the `TodoWrite` tool (CORE-PARITY §B) as a thin display passthrough: the model resends the whole
list each call, the tool echoes it to the UI, done. That's the *happy-path slice* — and it leaves out the
machinery that actually makes a todo system work over a long session. In mature agents the tool itself is
small (~115 lines) and is backed by:

- **per-session storage** — app state keyed by session or agent id (the authoritative list, written by the
  tool);
- **a periodic reminder** — a turn-count scan (config `{10,10}`) re-injects the current list as a
  `<system-reminder>` once ~10 assistant turns pass with no TodoWrite call: one fixed message saying the tool
  hasn't been used recently, followed by the existing list;
- **the prompt** (185 lines) — when/when-not, examples, and a rule never to mark a task completed while its
  tests fail.

Without storage the list dies at the next compaction; without the reminder the model drifts off the checklist
mid-task. We had **neither**. This ADR builds the foundation — and makes it *stronger* than that common
design, rather than reproducing the surface.

## Decision

A small, session-scoped todo subsystem wired like the freshness cache (ADR-032): created in `session.ts`,
threaded `LoopDeps → ToolContext`, written by the tool, read by the loop.

- **`TodoStore`** ([tools/todoStore.ts]) — the authoritative list, keyed by **agent depth** (main vs each
  subagent). Survives compaction (it's not in the transcript) and — *beyond the usual in-memory store* —
  **persists to `<cwd>/.cascade/todos.json`**, so the checklist survives a server/extension restart. Load and
  save are best-effort; persistence can never break a tool call.
- **`TodoWrite` does three jobs** ([tools/builtins/TodoWrite.ts]): the UI `todos` display (unchanged);
  `todoStore.set(depth, items)`; and **enforces the invariants the usual design only asks for in prose** — if
  >1 task is `in_progress`, or none is while work is pending, the result carries a `⚠` correction the model acts
  on next call. (The usual tool validates none of this.)
- **State-aware reminder** ([agent/todoReminder.ts]) — `todoReminderCounts` uses the standard backward scan
  (assistant turns since the last TodoWrite and since the last injected reminder), but the reminder text is
  built from the list's *actual state*: a list with >1 in_progress, none-in_progress, or normal progress each
  gets a **different** directive, with the live list rendered (`✔ ▶ ☐`) — not one fixed string. Default
  thresholds 6/6 (tighter than the common 10/10 — Cascade build sessions are shorter); injectable via `LoopDeps`.
- **Injection** ([agent/agentLoop.ts]) — at the top of the loop (after compaction), if the model has gone idle
  on the checklist, the reminder is **appended as a text block to the trailing user message** (always a user
  message there — initial input or tool_results). The OpenAI converter ([openaiCompat.ts:38-53]) splits
  `tool_result` blocks into `role:'tool'` messages and text into a `role:'user'` message, so this emits a
  clean `…tool, tool, user(reminder)` sequence — valid alternation, no converter change. A sentinel in the
  text lets the next turn's scan find it (so we never re-nag back-to-back). It is **not** yielded as an
  activity event ⇒ it reaches the model but never the UI.

## Why this is stronger than the common design

| | Common design | Cascade (this ADR) |
|---|---|---|
| Storage | in-memory app state | in-memory **+ persisted** to `.cascade/todos.json` (survives restart) |
| Reminder | one fixed nag string | **state-aware** directive (>1 in_progress / none / normal) + rendered list |
| Invariants | asked for in the prompt only | **enforced** in the tool result (`⚠` correction) |
| Subagents | keyed by agentId | keyed by depth (each agent its own scope) |

## Consequences

- The checklist is now durable: compaction can summarize the transcript and the list + reminder still work; a
  restart reloads it. The reminder re-grounds a drifting model with an *actionable* state-aware nudge.
- The reminder rides a normal user message (no new message type), so the whole pipeline — converter, tracer,
  compaction — handles it with zero special-casing, and it stays out of the UI because the loop doesn't yield it.

## Verification

- **Headless surface, 17/17** — drove the **real `runAgentLoop`** with a scripted provider: TodoWrite once
  then idle tool-calls ⇒ **exactly one** reminder injected at the threshold; it renders the in_progress
  `activeForm` + glyphs; `toOpenAIMessages` places it as a `role:'user'` message **right after** a `role:'tool'`
  (valid sequence, every tool message keyed); gating holds (no reminder right after a write, or for an
  empty/all-completed list); the tool warns on >1 in_progress and on pending-without-in_progress; a fresh
  `TodoStore` reads a prior one's persisted list. **93/93** existing tests green.
- **Live (qwen36-agentic + Docker)** — a 3-step TodoWrite task wrote `.cascade/todos.json` (keyed `"0"`,
  full `{content,status,activeForm}`), updated it to **3/3 completed** across the run; `notes/a.txt`·`b.txt`
  landed in the project (the model used `/app/notes/…`, remapped by ADR-033); the UI showed one `Tasks 3/3`
  card with **no `<system-reminder>` leak** anywhere in the transcript.

## Follow-ups

- Stuck-detection: trigger a reminder when one item sits `in_progress` for K turns (needs per-item transition
  tracking) — a genuine step beyond the common design, deferred deliberately.
- Enrich the tool prompt toward the depth of a mature 185-line guidance (examples, and not marking a task
  completed while its tests fail).
- A reopen view that renders the persisted `.cascade/todos.json` on project load.
