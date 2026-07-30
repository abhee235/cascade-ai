---
name: new-app
description: Workflow for building a NEW application/website/game from scratch — scaffold with the official generator, plan, implement fully, verify with build + Browser audit.
whenToUse: The user asks to create a new app, website, game, prototype, or library from scratch (not modify an existing one). Load BEFORE writing any file.
---
# New application — scaffold first, verify last

Goal: deliver a visually polished, substantially complete, WORKING prototype — not a stub. The two
failure modes this skill exists to prevent (both measured): hand-writing boilerplate from memory
(package.json/tsconfig/vite config written by hand → config drift, wasted turns, giant planning stalls)
and declaring done without looking at the running page (sections shipped invisible three builds in a row).

## 1. Place it correctly

- Create the app in a NEW subfolder of the workspace (e.g. `./<app-name>/`) with its own package.json.
- If the workspace already contains a project (a package.json, a monorepo `packages/` tree), do NOT
  integrate into it — do not edit its root package.json, do not add a workspace package — unless the user
  explicitly asked for that. When unsure, use AskUserQuestion once: new subfolder vs integrate.

## 2. Scaffold with the ecosystem's generator — never hand-write boilerplate

Use Bash to run the official scaffolder, then MODIFY the working baseline:

- Website / web app: `npm create vite@latest <name> -- --template react-ts`, then `npm install` and add
  Tailwind if styling is non-trivial.
- 3D (product pages, visualizations, 3D games): same Vite scaffold + `npm install three`; write plain
  three.js in a React component unless the user asks otherwise.
- 2D game: same Vite scaffold; render with a plain `<canvas>`; expose `window.__DEBUG__`
  (state()/step(n)/seed()) so behavior can be probed, not guessed.
- Node API/CLI: `npm init -y` + TypeScript only if the project needs it.

Honor the user's explicit stack choices over these defaults. After scaffolding, delete demo cruft you
won't use (logo assets, counter demo) rather than building around it.

## 3. Plan, then implement fully

- Capture the feature list as todos (TodoWrite) BEFORE writing app code; keep exactly one in_progress.
- Keep components small (one responsibility per file) and finish each feature — no placeholders left
  behind unless impossible (then say so). Source real-looking copy and data; never lorem-ipsum a hero.

## 4. Verify — build, then LOOK at it

1. `npm run build` (or `npx tsc --noEmit && npx vite build`) must pass with zero errors.
2. Start the dev server DETACHED (see the Bash tool notes — it blocks if run in the foreground), confirm
   it answers with curl.
3. Browser tool: `open` the URL → `snapshot` (structure present?) → **`audit`** (MANDATORY — catches
   sections stuck invisible at opacity 0 and console errors; FAIL means fix and re-run) → one
   `screenshot` for visual judgment. Name concrete problems and fix them.
4. Set the real page `<title>` and a favicon — the "Vite + React" default title is a shipped bug.

## 5. Deliver

End with: what was built (file map, one line per file), the verified build/audit results, and the exact
command to run the app. Never claim "done" for anything you did not verify in steps 4.1–4.3.
