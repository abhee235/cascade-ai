# Phase 7 — Permissions

**Goal:** gate every tool call before it runs — allow / ask / deny — with an approval card that
**blocks the loop** until the user answers, plus permission *modes* and allow/deny *rules*.

## 🎯 You'll understand
How an agent stays safe with a not-fully-trusted model: the **gate between intent and effect**. And the
subtle mechanism that makes interactive approval possible — pausing an async generator mid-turn and
resuming it from a *different* event (the user's click) on a single thread.

## The two ideas
1. **A pure resolver** — `checkPermission(tool, input, state)` → `allow | ask | deny`. All policy, no
   I/O. It layers **mode → rules → capability → write-default** (see ADR-009):
   - `bypass` → allow all (sandboxed web frontend, no prompts).
   - `plan` → reads allow, writes deny.
   - explicit `deny`/`allow` rule → that.
   - read-only tool → allow (never interrupt for a read).
   - write: `acceptEdits` → allow, `default` → **ask**.
2. **The async pause/resume across the protocol boundary.** When the gate says `ask`, the scheduler
   `yield`s a `permission` ActivityEvent (the card appears) and then `await`s a promise. That `await`
   hands control back to the event loop, so the webview's button handler can run, post
   `{type:'permission', id, decision}`, and the provider calls `session.respondPermission(id, …)` —
   which resolves the promise and **wakes the parked loop**.

## What we built
**Core (`@cascade/core`):**
- `permissions/gate.ts` — `PermissionMode`, `PermissionState` (`mode` + `allow`/`deny` Sets),
  `checkPermission()` (pure), and `PermissionController` (the async bridge; lives on `ToolContext`, not
  the wire — it holds a function).
- `protocol.ts` — new `permission` ActivityEvent (`{id, tool, detail}`). `InboundMessage.permission`
  already existed from Phase 0.
- `tools/scheduler.ts` — gates each tool before running: `allow` → run; `deny` → error tool_result, no
  execution; `ask` → yield `permission`, `await perm.request(id)`. `allow-always` adds to `state.allow`.
- `session.ts` — owns the `Map<id, resolve>`; `respondPermission(id, decision)` resolves it; `abort()`
  resolves pending prompts as `deny` so the loop unwinds. `SessionOptions` gains `mode`/`allow`/`deny`.
- `agentLoop.ts` — threads `permission` from deps into `ToolContext`.

**Extension:**
- `ui/App.tsx` — a permission card (Allow once / Always allow X / Deny) on the `permission` event; the
  buttons post the inbound `permission` message.
- `CascadeViewProvider.ts` — reads `cascade.permissionMode` (+ `allowTools`/`denyTools`) and passes them
  to `createSession`. (Inbound `permission` → `respondPermission` was already routed.)
- `package.json` — settings `cascade.permissionMode` / `allowTools` / `denyTools`.

## Verification (deterministic — `npm test`, 21 passing)
- `gate.test.ts` — checkPermission across every mode + rule combination.
- `permission.test.ts` — scheduler gating: a denied write yields a `permission` event, never executes,
  returns an error tool_result; `allow-always` runs the write *and* remembers it; a read never prompts.

## ✅ Test queries (F5 Dev Host, mode = default)
1. "Create notes.txt with 'hello', then delete it." (or any write) → an approval card appears; **Deny**
   → the model sees the denial and adapts (doesn't write).
2. Set `cascade.permissionMode` to `plan` → "Create notes.txt" → blocked (no card, denied). Set it to
   `acceptEdits` → the same write runs with **no** prompt.

## ✅ Self-check
*Which step holds the permission check, and what blocks the loop on "ask"?* → The scheduler checks
permission per tool *before* `executeTool`. On `ask` it yields a `permission` event and `await`s
`perm.request(id)`; that promise (held in the session's pending map) only resolves when
`respondPermission(id, …)` is called from the user's click — so the `await` is what blocks the loop.

## Pitfalls
- Don't put `PermissionController` in the wire protocol — it holds a function (not serializable).
  Only the `permission` ActivityEvent (plain JSON) crosses the boundary.
- The loop must *await* the answer, not poll — and `abort()` must release waiters or the loop hangs.
- `plan` mode must deny writes *before* allow-rules are consulted, or a stale allow leaks a write.

## "Allow always" scope (a gotcha worth knowing)
- It is **tool-wide**: allow-always `Write` skips the prompt for *all* later writes this chat, any file —
  not just the one you approved (keyed by `tool.name`). The button label ("Always allow Write") says so.
- **New chat (`reset()`) forgets it.** Runtime grants are cleared back to the settings-seeded rules, so a
  fresh chat asks again — otherwise the open gate would silently carry over between conversations.

## Not yet
- Rules are session-scoped (in-memory) + seeded from settings; cross-session persistence is deferred.
- `Bash` (input-dependent read-only) arrives in Phase 8 and rides the same gate.
