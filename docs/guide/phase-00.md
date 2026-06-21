# Phase 0 — Monorepo scaffold & "hello webview"

**Goal:** A workspaces monorepo with a headless `@cascade/core` and a VS Code `extension` that opens a
Cascade sidebar and echoes through a `CascadeSession` stub from core. No model yet.

## 🎯 You'll understand
The host/webview split **and** the core/frontend split — why the algorithm lives in a headless package
the extension merely *drives*, so a web app can later drive the same package.

## What we built
- Root `package.json` (npm workspaces), `tsconfig.base.json`, `.gitignore`.
- `packages/core` — `protocol.ts` (`ActivityEvent` / `InboundMessage` / `Message`), `session.ts`
  (`createSession()` stub whose `submit()` echoes a final `message`), `index.ts` (public surface).
- `packages/extension` — manifest with a sidebar webview view + settings, `esbuild.mjs` (host + webview
  bundles), `extension.ts` (`activate`), `CascadeViewProvider.ts` (drives a session in-process, bridges
  to the webview via `postMessage` with a CSP nonce), React UI (`ui/App.tsx`).
- `.vscode/launch.json` + `tasks.json` (F5 → Extension Development Host, builds first).
- ADRs: `ADR-001-stack`, `ADR-018-core-frontend-split`.

## The seam (why this matters)
```
webview (React)  --postMessage-->  CascadeViewProvider  --in-process-->  createSession() [@cascade/core]
       ^                                   |                                     |
       \-------------- ActivityEvent ------/-------------- submit() async iterable
```
In Phase 12 a WebSocket server replaces the "in-process" arrow with a socket — same `ActivityEvent`s,
different transport. The engine never changes.

## Build & run
```sh
npm install
npm run build -w @cascade/extension
# open cascade/ in VS Code → F5 → Cascade icon in the activity bar
```

## ✅ Test queries
1. `hello` → assistant bubble `echo: hello`.
2. Reload the Dev Host window → sidebar reopens, interactive.

## ✅ Self-check
*What must NEVER be imported inside `@cascade/core`, and why does that enable the web app later?*
→ No `vscode` and no DOM/browser globals. Keeping the engine free of frontend-specific imports is what
lets the same `createSession()` run inside the extension (in-process) **and** inside a server that
streams to a browser (over WebSocket). The boundary is the serializable `ActivityEvent` protocol.

## Pitfalls hit / avoided
- `@types/node` was needed for the host tsconfig (`process.cwd()`); added it.
- Core uses **extensionless** relative imports so esbuild bundles the TS without a `.js`→`.ts` plugin.
- Webview script is gated by a CSP nonce; `enableScripts` + `localResourceRoots` set on the webview.
