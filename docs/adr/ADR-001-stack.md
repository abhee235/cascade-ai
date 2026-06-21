# ADR-001 — TypeScript VS Code extension + React webview UI

**Status:** Accepted (Phase 0)

## Context
Cascade is a coding agent built from scratch as a learning project, delivered first as a VS Code
extension (alongside the other agent extensions in that ecosystem). We need a UI surface for a streaming
chat agent and a host with filesystem/network/process access.

## Decision
- **Language:** TypeScript (strict).
- **Host:** VS Code Extension API. The extension runs in a Node process and contributes a sidebar view.
- **UI:** React rendered inside a `WebviewView` (a sandboxed iframe). Host ↔ webview communicate only
  via `postMessage`.
- **Bundler:** esbuild — two bundles: `dist/extension.js` (CommonJS, Node) and `dist/webview.js`
  (IIFE, browser).

## Consequences
- The webview cannot touch the filesystem/network directly; the host does that and posts results in.
  This is the structural reason agent logic must live outside the UI.
- esbuild keeps builds near-instant, which matters for the phase-by-phase F5 loop.
- A Content-Security-Policy with a per-load nonce gates the only script the webview may run.

## Prior art
Terminal coding agents commonly render an **Ink** TUI (terminal React) rather than a webview, but the
same separation holds: rendering is isolated from the agent core. Cascade uses a webview instead of Ink
because the end goal is a GUI extension + web app, not a terminal.
