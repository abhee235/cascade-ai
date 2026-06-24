# Learning: permission gates vs sandboxes (and why hosted app builders don't prompt)

## Q: Do hosted app builders show per-action approval gates when building an app?
No. They run the agent in an **isolated cloud sandbox** (disposable container) and build autonomously —
no per-write/-exec prompts. You review the **outcome** (preview + diff + revert), not each action.
Per-action allow/deny is a **coding-agent-on-your-machine** thing (local coding agents and IDE
assistants, including our VS Code extension), because there the agent touches your **real** filesystem
and shell.

## The principle
**Permission gating is a substitute for sandboxing.**
- No sandbox (extension/CLI on your machine) → **gate** writes/exec; the prompt is the safety boundary.
- Sandbox (a hosted builder's container; a future Cascade web backend in a disposable container) → **don't
  gate**; the container *is* the boundary. Run autonomously; let the user review/undo.
Same engine, different blast radius → different gating.

## We don't need a new flag — the permission *mode* is the knob
A session-level **mode**, set by the frontend/deployment:
- `default` — auto-allow reads, **ask** for writes/exec (VS Code extension).
- `acceptEdits` — auto-allow edits; ask for risky exec.
- `plan` — block all writes.
- `bypass`/`auto` — allow everything, no prompts (**a sandboxed app-builder frontend**).

So a sandboxed app-builder Cascade frontend runs the same engine in `bypass`; the extension runs in `default`.

## Design consequence (Phase 7)
`checkPermission` consults, in order: **mode** (bypass→allow, plan→deny writes) → **allow/deny rules** →
fallback **ask**. That layering lets one permission system serve both the gated (extension) and ungated
(sandboxed web) worlds — supporting the North Star without a redesign.

## Prior art
Local agents commonly ship permission modes + rules, plus a skip-all-permissions flag for sandboxed/CI
runs (= our `bypass`). Same idea: the mode is chosen by how/where it's deployed.
