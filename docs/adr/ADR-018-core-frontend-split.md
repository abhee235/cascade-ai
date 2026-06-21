# ADR-018 — Frontend-agnostic core + transport boundary

**Status:** Accepted (Phase 0; fully realized in Phase 12)

## Context
The VS Code extension is only the *first* frontend. We also want a standalone web app / chat (like a
hosted chat assistant) driving the **same** agent algorithm. If the agent logic were entangled with `vscode` or
the DOM, a second frontend would mean a rewrite.

## Decision
Split the codebase into a **monorepo** with a headless engine and thin frontends:

- **`@cascade/core`** — the algorithm. **No `vscode`, no DOM imports, ever.** Its only public surface
  is `createSession(opts): CascadeSession`. A session is driven with `submit()` (an async iterable of
  `ActivityEvent`s), `respondPermission()`, and `abort()`.
- **`ActivityEvent` / `InboundMessage`** (`core/protocol.ts`) are plain JSON-serializable types — the
  **wire protocol**. They are the only things that cross any boundary.
- **Frontends** consume a session two ways:
  - **In-process** — the extension imports `@cascade/core` and calls `createSession()` directly.
  - **Over a transport** — a server runs the core and relays the identical `ActivityEvent`s over
    WebSocket to the web app (Phase 12).

Because the engine only ever emits/accepts serializable messages, the in-process and remote paths are
interchangeable; neither the engine nor a frontend needs to know which is in use.

## Consequences
- Hard rule enforced from Phase 0: nothing in `@cascade/core` may import `vscode` or browser globals.
- The protocol must stay serializable — no functions/classes inside `ActivityEvent`s.
- Adding the web app later (Phase 12) is "add a transport," not "rewrite the agent."

## Prior art
Agents with several frontends commonly separate a query engine (session history + the loop) from the
frontends: a terminal CLI, a web terminal server, and remote sessions over transports
(WebSocket/SSE/hybrid). Cascade's `CascadeSession` plays the query-engine role, and the `ActivityEvent`
protocol plays the role of the bridge messaging between a remote session and its client.
