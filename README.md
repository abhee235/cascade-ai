# Cascade

An AI coding agent, **Ollama-native**, built from scratch as a phase-by-phase learning
curriculum. One headless engine (`@cascade/core`), many frontends (VS Code extension now; web app later).

> Full curriculum and ADRs: see the approved plan and `docs/`.

## Current phase
**Phase 0 — Monorepo scaffold & "hello webview".** The extension opens a Cascade sidebar; messages are
echoed through a `CascadeSession` stub from `@cascade/core`. No model yet (that's Phase 1).

## Layout
```
packages/
  core/        @cascade/core — headless engine (no vscode, no DOM)
  extension/   VS Code frontend — drives the core in-process via a webview
docs/{adr,guide}/
```

## Prerequisites
- Node ≥ 18, VS Code.
- (From Phase 1) Ollama running: `ollama serve`; a tool-capable model pulled, e.g.
  `ollama pull qwen2.5-coder`. Use `127.0.0.1`, not `localhost`, on Windows.

## Build & run
```sh
npm install
npm run build -w @cascade/extension      # builds dist/extension.js + dist/webview.js
```
Then open this folder in VS Code and press **F5** ("Run Cascade Extension") → an Extension Development
Host opens → click the Cascade icon in the activity bar → type a message.

## Phase 0 verification
1. Type `hello` → an assistant bubble shows `echo: hello` (proves core → frontend pipe).
2. Reload the Dev Host window → the sidebar reopens and is interactive.

## Settings
- `cascade.model` (default `qwen2.5-coder`)
- `cascade.baseUrl` (default `http://127.0.0.1:11434`)
