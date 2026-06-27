# Phase 15 — App templates & scaffolding

**Goal:** a new project starts from a **runnable scaffold** (Vite + React + TS + Tailwind) with a git
baseline — so the agent edits a real app from turn one, and Preview/Code/checkpoints have something to work
with. (ADR-025.)

**🎯 You'll understand:** scaffolding is a **server** concern; a template's AI rules reach the model through a
single **generic** core seam (`extraInstructions`) — core never learns what a "template" is.

**The idea:**
- Templates are server assets: `packages/server/templates/<id>/` + `server/src/templates.ts`
  (`listTemplates` / `applyTemplate` / `readAiRules`).
- `ProjectManager.create(name, templateId?)` copies the scaffold + `git init` + a baseline commit.
- The template's `AI_RULES.md` is read **fresh on open** and passed as `SessionOptions.extraInstructions`
  (appended to the system prompt). Core stays headless — it only sees a string.
- Protocol: `templates` `BuilderEvent` (populates the picker) + optional `templateId` on `project:create`.
  Web: a template `Select` in the create flow (default = first template; "Blank" = empty dir).

**Cascade modules touched:**
- core: `agent/systemPrompt.ts` (`extraInstructions`), `agent/agentLoop.ts` + `session.ts` (thread it).
- server: NEW `templates/react/` scaffold + `templates.ts`; `projectManager.ts` (`create(name,templateId)` +
  `gitInit`; `open` reads AI rules); `wsServer.ts` (send `templates`, pass `templateId`).
- app-protocol: `TemplateInfo`, `templates` event, `templateId` on create.
- web: `store.ts` (templates state), `Sidebar.tsx` (template picker).

**Build checklist:**
- [x] Generic `SessionOptions.extraInstructions` → system prompt (core).
- [x] `templates/react/` scaffold (package.json/vite/tsconfig/index.html/src + `AI_RULES.md` + `_gitignore`).
- [x] `applyTemplate` (copy + `_gitignore→.gitignore`); `readAiRules` (fresh).
- [x] `ProjectManager.create(name, templateId?)` copies + `git init` + baseline commit; `open` injects rules.
- [x] Protocol `templates` event + `templateId`; server sends templates on connect.
- [x] Web template picker (shadcn `Select`) in the create flow.

**⚠️ Pitfalls:** putting template *files* or "template" concepts in core (they're server assets; core gets a
string); shipping `.gitignore` literally (use `_gitignore`, rename on copy); baking AI rules in instead of
reading fresh (the agent can edit them); forgetting the baseline commit (Phase 18 needs it).

**Test queries (verified):**
1. New project → React template → Create → the project dir has `package.json` (Vite), `src/App.tsx`,
   `.gitignore`, `AI_RULES.md`, and a `.git` repo with "Initial commit from template". ✅
2. `npm test` — `templates.test.ts` + the create-from-template `projectManager` test pass (87 total). ✅

**✅ Self-check:** *Why do template files live in the server while the rules end up in core's system prompt —
and what keeps core headless?* — The scaffold is filesystem + git setup (server). The rules are passed to
core as a plain `extraInstructions` string via a generic seam; core never reads template files or knows about
"templates", so it stays headless and reusable by any frontend.

**Next:** a **File service** + the **Code pane** (M4: file tree + Monaco) so you *see* the scaffolded files;
then **Live preview** (run the dev server in the 13.3 sandbox → proxy → iframe).
