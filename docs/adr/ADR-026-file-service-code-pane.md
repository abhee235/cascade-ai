# ADR-026 — File service & Code pane (M4)

## Context

With Phase 15 a project is a real app on disk. The builder needs to **show those files** — a file tree + an
editor — so you can see what the agent created and watch it edit. Question: where does file reading live, and
how does it cross to the web without leaking host paths or violating the headless-core rule?

## Decision

**A read-only file service in the server, surfaced over `@cascade/app-protocol`; Monaco in the web Code tab.**

- **Server** (`fileService.ts`): `readTree(dir)` (recursive, dirs-first, skips `node_modules`/`.git`/`dist`/
  `.vite`, depth cap) and `readFile(dir, relPath)` (path-traversal guard, 256 KB cap, binary flag). Files are
  read **host-side** with `node:fs` — the project dir is the source of truth (and is bind-mounted into the
  sandbox), so no need to route reads through Docker. `ProjectManager.dirOf(id)` exposes the host dir
  **server-internally only**.
- **Protocol**: a `FileNode` type with **relative** paths (host paths never cross the wire); `files`
  (tree) + `fileContent` (one file) `BuilderEvent`s; `files`/`file` `BuilderCommand`s. The server sends the
  tree on **project open** and **after each turn** (the agent may have edited files), and a file's content on
  demand.
- **Web**: a `FileTree` (expand/collapse, dirs-first) + **Monaco** (`@monaco-editor/react`) in the Code tab.
  **Read-only for now** — you watch the agent work; gated saving comes later (a Monaco edit must go through a
  permitted write, never a silent host write — the M4 pitfall).

## Consequences

- **You can see the project.** The scaffold's tree renders and any file opens in Monaco (syntax-highlighted,
  theme-synced). The tree auto-refreshes after each agent turn.
- **Core untouched.** File browsing is a pure server/protocol capability — no core changes (the agent still
  edits via its tools; this is a *viewer*).
- **Host-path-safe.** Only relative paths + content cross the wire; `dirOf` stays server-internal; traversal
  is blocked.
- **Read-only is deliberate.** Editing + save (gated) and create/rename/delete from the tree are a follow-up,
  so we don't bypass the permission model.
- **Monaco loads via its default (CDN) loader** for now; self-hosting the Monaco assets is a later
  optimization.

## Verification

- Unit: `fileService.test.ts` — tree (dirs-first, skips `node_modules`, relative paths), `readFile` content,
  traversal blocked. 90 tests pass.
- Runtime: open a scaffolded project → Code tab shows the full tree; clicking `src/App.tsx` loads its real
  content into Monaco.

## Prior art

A file tree plus a Monaco editor/diff editor reading the app directory is the common shape for an in-app code
view. Cascade uses that shape, keeps the read in the **server wrapper** behind the protocol (no headless-core
involvement), and starts read-only.
