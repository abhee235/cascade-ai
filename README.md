# Cascade

A local-first, **Ollama-native** AI coding agent — and a **prompt-to-app builder** built on top of
it. One headless engine (`@cascade/core`) drives many frontends (a VS Code extension, and a web builder) over
a single serializable protocol.

Cascade is built **from scratch, phase by phase**, as a learning project that derives a coding agent's
algorithm from first principles (it is **not** a fork) and then pivots that engine into a browser app
builder — build whole apps from prompts, with a file tree + editor + **live preview**, where the agent's
code runs **sandboxed** in a per-project Docker container so it can't touch your machine.

> **Status:** the core "prompt → running app" loop works. See [`docs/PROGRESS.md`](docs/PROGRESS.md) for the
> live dashboard (engine 100%; builder ~35%).

---

## What works today

- 🧠 **Headless agent engine** — streaming agentic loop, tools (Read/Write/Edit/Glob/Grep/Bash/Subagent),
  permissions, lazy MCP, 3-tier memory, context compaction, error-recovery, subagents.
- 🌐 **Web builder** (Vite + React + Tailwind + **shadcn/ui**, dark/light) — a resizable 3-pane
  shell: chat ∣ file tree + **Monaco** editor ∣ **live preview**.
- 📦 **Projects from templates** — a new project scaffolds a runnable Vite+React+TS+Tailwind app + a git
  baseline; each project gets a dedicated, long-lived session.
- 🐳 **Sandboxed execution** — the agent's shell + the dev server run in a **per-project Docker container**
  (host stays untouched); a generic `Sandbox` seam keeps `@cascade/core` Docker-agnostic.
- ▶️ **Live preview** — runs the project's dev server in its container, publishes the port, and iframes it.
- 🧩 **VS Code extension** — the same engine, driven in-process.

---

## Architecture

The Golden Rule: **`@cascade/core` is only the sessioned agent loop.** Anything app/workspace/UI-specific
(projects, sandbox, preview, templates, file browsing) lives in a **wrapper** (the server) and crosses a
single serializable protocol — `ActivityEvent` (engine → UI) / `InboundMessage` + `BuilderEvent`/`BuilderCommand`
(UI → engine). That's what makes the extension (in-process) and the web app (over WebSocket) interchangeable.

```
 Frontends:  @cascade/web (browser)        @cascade/extension (VS Code)
   consume:  ActivityEvent ∪ BuilderEvent   send: InboundMessage ∪ BuilderCommand
        │  WebSocket                              │  in-process
 Wrapper:  @cascade/server  (+ @cascade/app-protocol = builder wire types)
   • ProjectManager (project → dir + dedicated session)   • DockerSandbox (per-project container)
   • PreviewManager (dev server in the sandbox → iframe)  • file service, templates
        │  createSession() / session.submit()
 Engine:  @cascade/core — PURE, headless (no vscode, no DOM, no Docker)
   • agent loop · tools · permissions · memory · compaction · resilience · MCP
   • generic injection seams: ModelProvider, Sandbox, extraInstructions, …
```

### Monorepo layout
```
packages/
  core/          @cascade/core         — the headless engine (the algorithm)
  app-protocol/  @cascade/app-protocol — the builder wire types (projects/preview/files…)
  server/        @cascade/server       — hosts the core over WebSocket; ProjectManager, DockerSandbox, preview
  web/           @cascade/web          — the browser builder (3-pane, shadcn, Monaco, iframe preview)
  extension/     @cascade/extension    — VS Code frontend (drives the core in-process)
docs/{adr,guide}/ · docs/PLAN.md · docs/PROGRESS.md
```

---

## Quick start (the web builder)

**Prerequisites:** Node ≥ 18 · [Ollama](https://ollama.com) running with a tool-capable model
(e.g. `ollama pull qwen2.5-coder`) · [Docker Desktop](https://www.docker.com/products/docker-desktop/)
(for the sandbox + live preview — without it, commands fall back to host exec with a warning).

```sh
npm install

# 1) start the engine server (WebSocket on :4319) — needs Ollama (+ Docker for sandbox/preview)
CASCADE_MODEL=qwen2.5-coder npm run dev -w @cascade/server

# 2) start the web builder (Vite on :5319) in another terminal
npm run dev -w @cascade/web
```

Open **http://localhost:5319** → create a project (React template) → ask the agent to build something →
watch it in the **Code** pane and hit **Run** in the **Preview** pane.

Server env: `CASCADE_MODEL`, `CASCADE_BASE_URL` (Ollama URL), `CASCADE_PROJECTS_ROOT`, `CASCADE_DOCKER_IMAGE`
(default `node:20-alpine`), `CASCADE_SANDBOX=off` to disable Docker.

**VS Code extension:** open the repo in VS Code → **F5** → drive Cascade from the sidebar.

```sh
npm test        # vitest (FakeLLM; no Ollama/Docker needed). Docker/live tests are gated by env flags.
```

---

## Deliberate design choices

- **Streamed output + activity view** — prose and thinking stream token by token, alongside a live "what it's
  doing" timeline of tool calls. *(ADR-013)*
- **Background MCP** — MCP servers connect in the background at startup and never block it; a server that
  failed is retried on first use. *(ADR-014)*

---

## Docs

- **[`docs/guide/`](docs/guide/README.md) — the user guide**: [getting started](docs/guide/getting-started.md) ·
  [connecting providers](docs/guide/providers.md) · [models & parameters](docs/guide/models.md) ·
  [the VS Code extension](docs/guide/extension.md) · [connectors (MCP)](docs/guide/mcp.md).
- [`docs/PLAN.md`](docs/PLAN.md) — the phased curriculum.
- [`docs/PLAN-web-frontend.md`](docs/PLAN-web-frontend.md) — the builder UI component catalog/roadmap.
- [`docs/PROGRESS.md`](docs/PROGRESS.md) — progress dashboard.
- [`docs/adr/`](docs/adr/) — architecture decisions · [`docs/guide/phase-00.md`](docs/guide/phase-00.md) — per-phase build guides.

---

*Built as a learning project. Ollama-native, local-first.*
