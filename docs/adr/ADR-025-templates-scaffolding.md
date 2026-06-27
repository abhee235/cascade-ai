# ADR-025 — App templates / scaffolding (Phase 15)

## Context

In 13.2 a "project" was an **empty dir** — the agent had nothing to build on, and there was no app to preview,
no files for a Code pane, no git history for checkpoints. A prompt-to-app builder starts every project
from a **runnable scaffold** (e.g. Vite + React + Tailwind) so the agent edits a real app from turn one.

Two questions, under the wrapper rule (core stays headless):
1. Where do scaffold files + the copy/git-init logic live?
2. A template ships **AI rules** ("this is a Vite+React+TS app; edit `src/`; use Tailwind") the agent must
   follow — how do those reach the model without putting template/app concepts into core?

## Decision

**Scaffolds are SERVER assets; the only core touch is a generic system-prompt seam.**

- **Templates live in the server**: `packages/server/templates/<id>/` (the files) + `server/src/templates.ts`
  (`listTemplates()`, `applyTemplate(id, dest)`, `readAiRules(dir)`). `applyTemplate` copies the files
  (skipping `node_modules`/`.git`/`dist`) and restores `_gitignore → .gitignore` (templates ship the dotfile
  underscored so it doesn't affect the Cascade repo).
- **`ProjectManager.create(name, templateId?)`**: when a template is given, copy the scaffold into the project
  dir and **`git init` + one baseline commit** (the foundation for Phase-18 checkpoints). No template ⇒ an
  empty dir (the old behavior).
- **AI rules → a generic core seam.** Core gains `SessionOptions.extraInstructions?: string`, appended to the
  system prompt in `buildSystemPrompt` (outside the conversation history, so compaction never drops it). The
  **server** reads the project's `AI_RULES.md` **fresh on open** (so the agent can edit its own rules) and
  passes it as `extraInstructions`. Core never reads template files or knows what a "template" is — it just
  gets a string, exactly like any frontend could supply.
- **Protocol** (`@cascade/app-protocol`): a `TemplateInfo` type, a `templates` `BuilderEvent` (sent on
  connect so the web can populate a picker), and an optional `templateId` on the `project:create`
  `BuilderCommand`. The web create-flow shows a template `Select` (default = first template, so new projects
  are runnable; "Blank" = empty dir).

## Consequences

- **Projects are real apps.** A new project is a runnable Vite+React+TS+Tailwind app with a git baseline —
  unblocking the Code pane (files to show), Preview (an app to run), and checkpoints (history to diff).
- **Core stays pure.** Adding scaffolding required **zero** app/template concepts in core — only a generic
  `extraInstructions` string seam (reusable by any frontend). Docker, templates, git, and AI-rule files all
  live in the server.
- **AI rules are editable + always fresh.** Read from disk on open rather than baked in, so the agent (or
  user) can change `AI_RULES.md` and the next turn honors it.
- **Extensible.** New templates are just a folder under `templates/` + a `REGISTRY` entry; GitHub-repo
  templates with a cache can come later behind the same `applyTemplate` seam.

## Verification

- Unit: `templates.test.ts` (list, copy + `_gitignore→.gitignore`, `readAiRules`, unknown-template throws) +
  `projectManager.test.ts` (create-from-template ⇒ scaffold files + `.git` baseline). 87 tests pass.
- Runtime: in the browser, New project → React template → Create produced a project dir with `package.json`
  (Vite), `src/App.tsx`, `.gitignore`, `AI_RULES.md`, and a `.git` repo with "Initial commit from template".

## Prior art

App builders commonly scaffold from a bundled template directory (optionally a cloned, cached repo) and inject
per-app rules into the system prompt. Cascade uses the same broad idea but keeps the template machinery in the
**server wrapper** and reduces core's involvement to a single generic `extraInstructions` string — an
all-in-one desktop app has no headless core to protect, so its scaffolding can live beside everything else;
Cascade's cannot.
