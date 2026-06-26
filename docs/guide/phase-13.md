# Phase 13 — The Builder (Server + Projects + Sandbox + Web)

Phase 13 pivots Cascade from "an agent driven by the VS Code extension" to a **prompt-to-app web
builder**: build whole apps from prompts, each in its own sandboxed workspace, with a live file tree +
editor + preview. It cashes in the Phase-0 split (ADR-018: headless core, one serializable protocol). It
ships in four runnable checkpoints — this guide grows one section per checkpoint.

---

## 13.1 — Server + WebSocket transport + minimal web (✅ tagged `phase-13.1`)

**Goal:** prove the core is frontend-agnostic over a real network boundary.

**What we built:**
- `@cascade/server` (`packages/server`): a `ws` `WebSocketServer`. `handleConnection` maps inbound JSON
  (`InboundMessage`) → session calls and relays every `ActivityEvent` the session yields back as JSON.
- `@cascade/web` (`packages/web`): Vite + React + Tailwind. `wsClient.ts` (auto-reconnect) +
  `App.tsx` — the SAME activity-first rendering the extension uses (user/assistant/tool/memory/compacted
  items, collapsible thinking, recovering card, Stop).

**Idea:** the browser can't import `core` in-process, so the server runs the core and forwards events:
`browser submit → WS → session.submit() → ActivityEvents → WS → browser`. Only serializable `ActivityEvent`s
cross the wire — that's why the extension (in-process) and web (remote) are interchangeable.

**Verified (browser, Playwright):** typed a prompt → the same timeline + final answer rendered, via
`web → ws → core → Ollama`.

---

## 13.2 — Projects / workspaces: a dedicated session per project (✅ this checkpoint)

**Goal:** turn the single shared chat into **multiple projects, each its own workspace + persistent session**
— the foundation the 13.4 builder UI stands on. (ADR-021.)

**The key shift — session ownership moves from the *connection* to the *project*:**
- 13.1: `connection ⇄ session` (1:1, ephemeral — dies with the socket).
- 13.2: `connection → attaches to → project → owns → session` (long-lived, keyed by project id).

**What we built:**
- `packages/server/src/projectManager.ts` — `ProjectManager` owns `Map<id, Project>`.
  - `create(name)` → a dir under the projects root + a metadata record (no session yet).
  - `open(id)` → **lazily** builds and **caches** the project's session (so its conversation persists).
  - `delete(id)` → disposes the session + removes the dir.
  - Metadata persists to `projects.json`; sessions never do. Reloaded on startup; re-sent to each new client.
  - `createSessionFor(dir)` is **injected** — the seam 13.3 uses to wrap each project in a Docker sandbox,
    and tests use to inject a FakeProvider.
- `packages/core/src/protocol.ts` — added the `project` control inbound, the `projects` snapshot outbound,
  and `ProjectInfo` (host-path-free). Headless: just types.
- `packages/server/src/wsServer.ts` — the manager is now a **server-wide singleton**; each connection keeps a
  per-socket "active session" pointer, routes `submit`/etc to it, and on close **detaches without disposing**
  (the session lives on in the manager). Sending with no project open → a gentle "open a project first".
- `packages/web/src/App.tsx` — a **project sidebar** (create / list / open / delete) + an empty state until a
  project is opened; the chat is routed to the active project.

**Test queries (browser):**
1. ＋ → name a project → it appears in the sidebar → open it → the composer appears, the header shows
   `Cascade / <name>` → send a prompt → it answers inside that project. ✅
2. Reload the page → the project is **still listed** (metadata persisted, re-sent on connect) but **closed**
   (a fresh connection has no active project until you open one). ✅

**Tests (headless, `npm test`):** `projectManager.test.ts` (create/open-caches/unknown-throws/delete/persist)
+ `wsServer.test.ts` (greets with project list; create→open→submit relays; submit-with-no-project nudges;
  malformed JSON ignored).

**⚠️ Pitfalls:**
- Disposing the session on socket close (defeats persistence) — detach only.
- Leaking the host `dir` over the wire — only `ProjectInfo` (`id/name/createdAt`) crosses.
- A TS type-guard predicate (`x is T`) needs a **parameter**, not a `let` closure var; capture the active
  session into a `const` per case so narrowing survives the `await`s.

**✅ Self-check:** *Where does a project's session live, and why does that make a project survive a browser
reload?* — It lives in the server's `ProjectManager`, keyed by project id, not in the WebSocket connection.
A reload opens a new socket but the manager (and its cached sessions + on-disk metadata) is untouched, so the
project list comes back and reopening re-attaches the same live session.

**Known v1 limitation:** opening a project clears the *local* transcript; server-side history persists but is
not yet replayed into the UI (a later phase).

---

## 13.3 — Docker sandbox (the isolation) — *next*

`Sandbox` interface on `ToolContext`; `Bash`/exec routes through it; the server provides a `DockerSandbox`
(exec in a per-project container). See the plan.

## 13.4 — Builder 3-pane UI — *after*

chat/activity | file tree + Monaco editor | live iframe preview (+ terminal/logs) + preview proxy.
