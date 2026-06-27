# ADR-027 — Live preview (M3)

## Context

The defining feature of a prompt-to-app builder: prompt → **see your app running**. The scaffold
(Phase 15) is a real Vite app and execution is sandboxed (13.3). We need to run its dev server and show it
in the web app — without running untrusted code on the host and without putting "preview" into the core.

## Decision

**Run the dev server inside the project's existing Docker container; publish its port to the host; iframe it.**
A `PreviewManager` in the server orchestrates it; a `preview` `BuilderEvent` carries the status/URL.

- **One container = the project's runtime.** No second container — the per-project sandbox (13.3) *is* where
  the dev server runs (`docker exec -d npm run dev`). The agent's commands and the dev server share it.
- **Port exposure (Windows-safe).** `DockerSandbox` starts the container with **`-p 0:5173`** (Docker assigns
  a free host port — race-free vs. picking our own) and reads it back with `docker port`. On Windows/WSL2 the
  container IP isn't reachable from the host, so **publishing a port is required** (not a host-network trick).
  `getHostPort()` exposes it; `execDetached()` runs the long-lived dev server.
- **`PreviewManager.start`**: `npm install` (only if `node_modules` missing) → `npm run dev` detached →
  **poll the host URL** until it answers → emit `preview {status, url}`. States: `installing → starting →
  running | error`. State is kept per project, so **re-opening a project re-attaches** a running preview.
- **Protocol**: a `preview` `BuilderEvent` (`installing|starting|running|error|stopped` + `url`) and a
  `preview` `BuilderCommand` (`start|stop`). The web shows a **Run** button → spinner → an **iframe** of the
  URL with a reload/stop toolbar.
- **Core: untouched.** Preview is 100% server + the existing `Sandbox` (the `DockerSandbox`-specific
  `getHostPort`/`execDetached` are server-side, surfaced via `ProjectManager.sandboxOf`).

## Consequences

- **The loop closes:** template → real app → runs in the sandbox → live, interactive preview in the browser.
  Verified: the iframe renders the app and its React counter increments on click (a genuinely live dev server,
  not a static render), served from `localhost:<published port>`.
- **Isolated by construction.** The dev server (npm, network, processes) runs in the container; the host only
  sees a forwarded port. Files come from the bind-mounted project dir, so the agent's edits are picked up by
  Vite HMR.
- **First run is slow** (`npm install` in the container) — surfaced as an `installing` state.
- **v1 limits (honest):** no reverse-proxy yet, so the iframe points straight at `localhost:<port>` (origin
  changes per project/restart; HMR works but there's no stable URL or injected error-capture). `stop` clears
  client state but doesn't kill the in-container dev process (teardown happens on project dispose). A
  proxy + real stop + a Console log pane are follow-ups.

## Prior art

Two shapes are common. An in-browser runtime runs the dev server inside the page — no server needed, but it is
a proprietary runtime. A local runner starts the dev server on the **host** (or opt-in Docker) and puts a proxy
in front of the dev URL for a stable origin and injected shims, shown in an iframe. Cascade takes the
proxy-iframe shape but runs the server **in the per-project Docker sandbox by default** (isolation first), with
the proxy as a planned follow-up.
