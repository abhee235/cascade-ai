# ADR-021 — Projects / workspaces: a dedicated session per project (Phase 13.2)

## Context

The Phase-13 North Star is a prompt-to-app builder: you build whole apps from prompts, each in its
own workspace, and you can leave and come back. Phase 13.1 stood up `@cascade/server` where **one WebSocket
connection owned one `CascadeSession`**, rooted at a single shared workspace dir. That's a stateless chat —
it has no notion of separate projects, and a project's conversation/workspace dies when the socket closes.

A builder needs:
- **Multiple projects**, each an isolated workspace dir.
- A **dedicated, long-lived session per project** (its conversation + tool history) that **survives the
  browser tab closing and reopening**.
- A sidebar to create / list / open / delete projects.

## Decision

Introduce a server-side **`ProjectManager`** that owns the projects and their sessions. **Session ownership
moves from the connection to the project.**

- A *project* = `{ id, name, createdAt, dir, session? }`. The `dir` is a subdir under a projects root on the
  host; `session` is created **lazily on first `open()`** (no Ollama-backed session until a project is
  actually opened — same instinct as lazy MCP, ADR-014) and then **cached** so the conversation persists.
- A WebSocket connection no longer creates a session. It **attaches** to a project (`{type:'project',
  action:'open', id}`) and routes `submit`/`abort`/`reset`/`mcp`/`memoryView` to that project's session. On
  socket close it **detaches but does not dispose** — the session stays alive in the manager for next time.
- **Metadata persists** to `projects.json` under the projects root (only `{id,name,createdAt,dir}` — never
  sessions). On startup the manager re-lists projects whose dirs still exist; on each new connection the
  server greets the client with the project list.
- Session construction is **injected** (`createSessionFor(dir)`), defaulting to a real Ollama-backed session.
  This seam is deliberate: **13.3 wraps it to give each project a Docker sandbox**, and tests inject a
  FakeProvider — the manager itself stays ignorant of Ollama/Docker.

The wire protocol gains a small **control** set (ADR-018 stays intact — still serializable JSON both ways):
- inbound `InboundMessage`: `{ type:'project', action:'list'|'create'|'open'|'delete', name?, id? }`
- outbound `ActivityEvent`: `{ type:'projects', projects: ProjectInfo[], activeId? }`
- `ProjectInfo = { id, name, createdAt }` — the host-path-free view; `dir` never crosses the wire.

## Consequences

- **Projects survive restarts** (metadata on disk) and **reconnects** (sessions held by the manager). Closing
  and reopening a tab returns you to your project list; opening a project re-attaches its live session.
- The server is now **stateful** (the `ProjectManager` is its core), not a per-socket relay. A connection is
  just a temporary viewport onto one project.
- **Known v1 limitation (no shortcut hidden):** opening a project clears the *local* transcript in the
  browser. The server-side conversation persists, but we don't yet **replay** history into a freshly attached
  UI. Transcript persistence + replay is a later phase.
- One active project per connection (v1). Two connections opening the same project would share one session;
  multi-viewer fan-out is out of scope for now.
- Isolation note: 13.2 confines *files* to a per-project dir, but tools still execute on the **host**. The
  execution sandbox (Docker per project) is ADR-(next)/Phase 13.3 — the `createSessionFor` seam is where it
  plugs in.

## Prior art

Agents with remote sessions commonly decouple a session from any single client transport: a server keeps
server-side sessions, and a session runner manages a remote session's lifecycle independently of the
connection relaying its events. Our `ProjectManager` is the same idea, scoped to "a session per project
workspace."
