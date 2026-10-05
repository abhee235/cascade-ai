# Cascade dev-tooling: the coding-agent primitives we use

This documents the **finite vocabulary** of coding-agent primitives we use to *develop* Cascade
(distinct from MCP/tools we *build into* Cascade), as described in the dev agent's own documentation.

## The 6 primitives

| Primitive | Lives in | For | Loads |
|---|---|---|---|
| **Project instructions** (memory) | the agent's instructions file at the repo root | durable facts & rules | always |
| **Skills** | `<agent-dir>/skills/<name>/SKILL.md` (+ files) | procedures, checklists, reference | on demand (`/name` or by description) |
| **Hooks** | `settings.json` → `hooks` | deterministic enforcement on lifecycle events | harness runs them |
| **Subagents** | `<agent-dir>/agents/<name>.md` | isolated side-work in its own context | delegated by description or explicit |
| **Settings** | `settings.json` | config: permissions, env, hooks, model | always |
| **Plugins** | a bundle | distributing the above | when installed |

`<agent-dir>` = the dev agent's config folder (project-level in the repo, user-level in your home dir).

Key facts: **custom commands merged into skills** (a skill *is* a `/command`); only `SKILL.md` loads
when a skill activates — companion files (`lesson.md`, `example.md`, `reference/*`) are pulled in with
the Read tool, so each `SKILL.md` opens with a "Read these first" block. **Additional dirs load only
`<agent-dir>/skills/`, not settings/hooks** — so hooks must live in the session's project or user settings.

## What Cascade has set up

### Skills (in the repo's `<agent-dir>/skills/`, committed with the project)
- **work-a-phase** — the per-phase ritual. Takes a phase number: `/work-a-phase 2`. Composition:
  `SKILL.md` (procedure) + `lesson.md` (why) + `example.md` (worked close-out) + `reference/checklist.md`.
- Roadmap (added when their code exists): `add-a-tool`, `add-an-adr`, research-subagent usage. See the
  skills folder's `README.md`.

### Subagent (user-level: `~/<agent-dir>/agents/`)
- **A source-tracing researcher** — read-only (`Read, Grep, Glob`). Give it a concept; it studies a
  reference codebase in its own context and returns a summary with `file:line` cites. Keeps deep
  cross-referencing out of the main conversation.

### Hook + Settings (user-level: `~/<agent-dir>/settings.json`)
- **warn-large-edit** (`PreToolUse` on `Write|Edit|MultiEdit`) → `~/<agent-dir>/hooks/warn-large-edit.mjs`.
  **Warn-only / non-blocking**: if an edit exceeds 100 lines it prints a `systemMessage` and exits 0
  (the edit still proceeds). Enforces the "≤100 lines per edit" working agreement as a nudge.
- **permissions.allow** — common safe dev commands run without prompting: `npm run build`,
  `npm install`, `npx tsc`, and read/write `git` verbs.

> Activation note: changing `settings.json` mid-session may need opening `/hooks` once (reloads config)
> or restarting the agent, because the settings watcher only watches dirs that had a settings file at
> session start. The hook config itself is valid (verified) and the script is pipe-tested.

## What we deliberately did NOT use
- **Plugins** — for distribution; we don't need to share yet.
- **Blocking hooks** — the line-limit is warn-only by choice; "explain before editing" stays a
  behavioral rule (a hook can't verify intent), recorded in the project instructions file → "Working
  agreement".
