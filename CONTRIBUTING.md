# Contributing to Cascade

Thanks for helping. This page is the short version of how the codebase is organised and the rules that keep
it working. The design history behind each rule lives in the decision records under [`docs/adr/`](docs/adr).

## What Cascade is

Cascade is an Ollama-native AI coding agent and a prompt-to-app builder built on it. One **headless engine**
(`@cascade/core`) drives several frontends: a VS Code extension (in-process) and a web builder (over a
WebSocket server), plus a desktop shell. It is designed for local models first — context economy, KV-cache
discipline, and recovery from weak-model failure.

## Repository layout

```
packages/core/          @cascade/core — the agent engine (headless): loop, tools, permissions,
                        memory, MCP, context compaction, providers
packages/server/        hosts core over WebSocket; projects, sandboxes, preview, the builder
packages/web/           the web builder (Vite + React + shadcn/ui)
packages/extension/     the VS Code extension
packages/app-protocol/  the shared app-level protocol types
packages/storage*/      session storage
packages/desktop/       the desktop shell
docs/adr/               architecture decision records (one per decision)
docs/guide/             phase guides — what was built, how to test it
eval/, scripts/eval/    the evaluation harness and its fixtures
```

## Setup

Prerequisites: Node.js 18+, [Ollama](https://ollama.com) with a tool-capable model for real runs, and Docker
Desktop for the sandboxed preview.

```sh
npm install
npm run typecheck     # every workspace
npm test              # Vitest with a fake model — no Ollama or Docker needed
```

Run the web builder (two terminals):

```sh
CASCADE_MODEL=<your model> npm run dev -w @cascade/server   # engine server on :4319
npm run dev -w @cascade/web                                 # web builder on :5319
```

Build the VS Code extension with `npm run build -w @cascade/extension`, then press F5 in VS Code
("Run Cascade Extension"). On Windows, use `127.0.0.1` rather than `localhost` for Ollama.

## Ground rules

1. **`@cascade/core` stays headless.** Never import `vscode` or any DOM/browser global inside
   `packages/core` — that is what lets every frontend share one engine.
2. **One protocol crosses every boundary:** the serializable `ActivityEvent` / `InboundMessage` types in
   `packages/core/src/protocol.ts`. No functions or classes in those payloads.
3. **One internal message model.** Content blocks (`text` / `thinking` / `tool_use` / `tool_result`)
   internally; each provider translates to and from its wire format only inside `llm/providers/*`.
4. **Stream everything through `ActivityEvent`s.** Prose and thinking stream token by token as deltas, a
   final `message` commits them, and frontends render only `ActivityEvent`s.
5. **MCP connects in the background** and never blocks startup; a failed server is retried lazily on use.
6. **Tests green before a pull request.** New or changed deterministic logic gets a test (Vitest, driven by
   the fake model); `npm test` and `npm run typecheck` must pass.
7. **Decisions get an ADR.** A change of approach is proposed as a new record in `docs/adr/` (context,
   decision, consequences, measurements) before the code.

## Pull requests

Keep changes focused, explain the *why* in the description, and link the ADR or issue it implements. By
contributing you agree your work is released under the [MIT license](LICENSE).
