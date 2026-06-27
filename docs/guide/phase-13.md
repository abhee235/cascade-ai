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

## 13.3 — Docker sandbox: the isolation (✅ tagged `phase-13.3`)

**Goal:** the agent's shell/exec runs in a per-project container, so model-authored code **cannot touch the
host** — without putting Docker into the headless core. (ADR-024.)

**The key idea — a generic seam, not a Docker dependency in core:**
- 13.1: `connection ⇄ session`. 13.2: `project → session`. 13.3: `Bash → ctx.sandbox` (when injected).
- Core defines only the *shape* of "run a command somewhere"; the server supplies *where* (Docker).

**What we built:**
- `core/src/sandbox/sandbox.ts` — a generic `Sandbox` interface (`exec(cmd, {cwd,signal,onData}) →
  {output,exitCode}` + `dispose()`). Injected via `SessionOptions → LoopDeps → ToolContext.sandbox` (and the
  subagent child loop). `Bash` routes through `ctx.sandbox.exec` when present; **host `spawn` fallback**
  otherwise (the VS Code extension is unchanged). Exported from `@cascade/core`. *This is the only sanctioned
  core change — a generic capability, like `ModelProvider`.*
- `server/src/dockerSandbox.ts` — `DockerSandbox`: one `--rm` container per project, the project dir mounted
  at `/workspace`, each command a `docker exec`, streamed output, `dispose()` tears it down;
  `dockerAvailable()` probe.
- `server` wiring — `ProjectManager` owns the sandbox per project (created on open, disposed on
  delete/shutdown); `wsServer` injects a `DockerSandbox` when Docker is up, else **host fallback + warning**
  (`CASCADE_SANDBOX=off` to opt out; `CASCADE_DOCKER_IMAGE` to change the image, default `node:20-alpine`).
  A sandboxed session runs in **`mode: 'bypass'`** (auto-allow) — it's contained, so the builder doesn't
  prompt for every command/edit.

**Test queries (verified):**
1. (Docker-gated, `CASCADE_DOCKER=1`) real container exec — commands run in `/workspace`, a file written
   inside the container appears in the host project dir (the isolation boundary), exit codes propagate. ✅ 4/4
2. End-to-end through the **real Ollama model**: "run `pwd && cat /etc/os-release && uname -s`" → the agent's
   Bash returns `/workspace`, `Alpine Linux`, `Linux` — i.e. it ran **inside the container, not on the
   Windows host**. ✅

**Tests:** `core/test/bash.test.ts` (Bash routes through a fake `Sandbox`; streams; nonzero exit; graceful
throw) + `server/test/dockerSandbox.live.test.ts` (Docker-gated). Suite: 81 pass + 5 gated skips.

**⚠️ Pitfalls:**
- Putting Docker/"container"/"project" concepts in core — keep them in the server; core only sees `Sandbox`.
- Forgetting the host fallback (the extension must still run host exec).
- A permission prompt hanging a sandboxed turn — sandboxed ⇒ `mode: 'bypass'` (auto-allow), since contained.
- Windows volume mounts — pass forward-slash drive paths (`C:/…`) to `docker -v`.

**✅ Self-check:** *Why can a core tool run inside Docker without core knowing Docker exists?* — Because
`Bash` calls an injected generic `Sandbox.exec`; core defines the interface, the **server** implements it
(`DockerSandbox`) and injects it per project. Swap Docker for gVisor/Firecracker later with zero core change.

## 13.4 — Builder 3-pane UI (✅ folded into M1 + the web-frontend plan)

The 3-pane shell (chat ∣ file tree + Monaco ∣ preview/terminal) shipped as **M1** (resizable shell + shadcn
+ the design system); the panes light up across the web-frontend milestones — see
[`docs/PLAN-web-frontend.md`](../PLAN-web-frontend.md). Live preview + terminal need the 13.3 sandbox.
