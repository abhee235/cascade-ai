# Frontend architecture & extensibility

How a UI drives Cascade, and why the same engine scales to a web app and a desktop app with **zero
core changes**. Companion to [ADR-018](adr/ADR-018-core-frontend-split.md) (the principle) and
[PLAN.md](PLAN.md) (the packages).

## The flow today (VS Code extension, core in-process)

```
Webview (React, sandboxed)                 ui/App.tsx
   input  ──▶ vscode.postMessage({submit})  ──────────────┐  InboundMessage (UI → core)
   render ◀── window 'message' (ActivityEvent) ◀────────┐ │
                                                        │ ▼
Extension host (Node)                       CascadeViewProvider
   onInbound(msg) ──▶ session.submit(text)              │
   for await (ev) ──▶ webview.postMessage(ev) ──────────┘  ActivityEvent (core → UI)
                                                        ▲
@cascade/core (headless: no vscode, no DOM)             │
   createSession().submit() ──▶ AsyncIterable<ActivityEvent>
```

## The contract vs the bridge

- **Stable everywhere — the contract:** `CascadeSession` + the `ActivityEvent` / `InboundMessage`
  JSON types in `core/protocol.ts`. Identical for every frontend. The core never knows who's attached.
- **Swappable per frontend — the bridge:** the ~30 lines that ferry those JSON messages between the
  UI and the session. This is the *only* thing that changes.

| Frontend | Where core runs | Bridge (transport) |
|---|---|---|
| VS Code extension (now) | extension host, in-process | `webview.postMessage` |
| Web app (Phase 12) | Node server | WebSocket |
| Desktop — Electron (future) | main process, in-process | Electron IPC (`ipcMain`/`ipcRenderer`) |
| Desktop — Tauri (future) | Node sidecar process | stdio / WebSocket |
| CLI / headless | same process | direct calls |

## Why desktop scales cleanly (validation)

- **Electron main process is Node — same as the extension host.** Core embeds in-process; swap
  `postMessage` for Electron IPC; reuse the React UI unchanged. Same model as the extension.
- **Tauri** can't host Node in-process → core runs as a **sidecar** behind a transport, which is exactly
  the Phase-12 web-server design. Same model as the web app.
- Every case: **no core changes.** New frontend = reused UI components + one small bridge.

## The rule that keeps it extensible

UI components depend ONLY on "`ActivityEvent` in / `InboundMessage` out" — they must never import
`vscode`, `ws`, or `electron`. Those belong only in the per-frontend bridge. Shared components live in
the planned `shared-ui` package; each frontend supplies its own bridge. Break this rule and a component
gets welded to one host, which is what blocks scaling to desktop/web later.

## Prior art: this shape is the common one
Mature agents run one core behind many frontends: a terminal UI, a web server, and remote transports
(WebSocket/SSE/hybrid). Cascade's `ActivityEvent` ≈ that bridge messaging; our `CascadeSession` ≈ the
core query engine.
