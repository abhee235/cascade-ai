# ADR-009 — Permissions: allow / ask / deny, with modes + rules

**Status:** Accepted (Phase 7)

## Context
The model is a not-fully-trusted planner: its `tool_use` blocks are *intentions*. Until now every
intention executed. On a real filesystem that's unsafe — a stray `Write`/`Edit` (or `Bash rm` later)
changes the user's machine. We need a **gate between intent and effect**. It must also serve two very
different deployments without a redesign: the **extension** (runs on your machine → must ask) and a
future **sandboxed web frontend** (an app builder → should run autonomously). See
`docs/learnings/permissions-vs-sandbox.md`: permission gating is a *substitute for sandboxing*.

## Decision
A **pure** resolver `permissions/gate.ts → checkPermission(tool, input, state): 'allow'|'ask'|'deny'`
that layers, in order:
1. **Mode** (the frontend's policy, `PermissionState.mode`):
   - `bypass` → **allow** everything (sandboxed; no prompts).
   - `plan` → reads **allow**, writes **deny** (explore only).
2. **Rules** (`state.deny` / `state.allow` sets — a remembered "never"/"always" per tool name).
3. **Capability**: read-only tools (`tool.isReadOnly`) → **allow** (never interrupt for a read).
4. **Write default by mode**: `acceptEdits` → **allow**, `default` → **ask**.

Purity keeps all policy testable in isolation. The messy async part — showing a card and *waiting* —
lives elsewhere:

- **`PermissionController`** (on `ToolContext`, NOT on the wire — it holds a function): `{ state,
  request(id): Promise<'allow'|'allow-always'|'deny'> }`.
- The **scheduler** gates each tool before running it. On `ask` it `yield`s a `permission`
  ActivityEvent (card appears) then `await perm.request(id)` — **this parks the loop**. On `deny` it
  skips execution and returns an *error* `tool_result` so the model can adapt. `allow-always` adds the
  tool to `state.allow` for the session.
- The **session** owns a `Map<id, resolve>`; `respondPermission(id, decision)` resolves the awaited
  promise — the moment the parked loop resumes. `abort()` resolves any pending prompt as `deny` so the
  loop unwinds instead of hanging.

The **frontend chooses the mode** (extension setting `cascade.permissionMode`, default `default`;
`cascade.allowTools`/`denyTools` seed the rules).

## Consequences
- One system serves both gated (extension) and ungated (`bypass`, sandboxed web) worlds — supports the
  North Star without a rewrite.
- Reads never prompt; only writes (and later Bash) can pause the loop.
- A denial is fed back as a tool_result, so the agent self-corrects rather than crashing.
- `await` yielding to the event loop is *why* the webview's click handler can run while the scheduler
  is parked — the single-threaded pause/resume that makes interactive approval possible.
- **"Allow always" is tool-wide** (keyed by tool name) for the rest of the session — it skips the prompt
  for *every* later call to that tool, any target, not just the one file. **`reset()` ("New chat")
  forgets these runtime grants** (restoring the settings-seeded rules + mode), so a new chat asks again.

## Prior art
The common design is a can-use-tool / check-permissions hook: permission modes (default / accept-edits /
plan / bypass) + allow/deny rule lists, evaluated before a tool runs; a CLI "skip permissions" flag is
the `bypass` mode. Same layering, same place in the pipeline.
