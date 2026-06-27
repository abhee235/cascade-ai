# ADR-024 — Execution sandbox: a generic core seam + Docker per project (Phase 13.3)

## Context

The North-Star builder runs **untrusted, model-authored code** — `npm install`, dev servers, arbitrary
shell. The host-escaping vector is **execution**, not file reads (files are already confined to a per-project
dir, ADR-021). So the agent's shell/exec must run somewhere it **cannot touch the host**.

The hard constraint (the project's load-bearing rule): **`@cascade/core` is only the sessioned agent loop;
anything app/infra-specific lives in a wrapper.** Docker is infra. So core must not learn about Docker — yet
its `Bash` tool is the thing that needs to run in a container. How do we redirect a core tool's execution
into a sandbox without putting Docker (or "containers", or "projects") into core?

## Decision

Introduce a **generic execution capability** as a core seam, and put **all Docker in the server wrapper**.

**Core (generic, app-agnostic):**
- `core/src/sandbox/sandbox.ts` — a `Sandbox` interface: `exec(command, {cwd, signal, onData}) →
  {output, exitCode}` + `dispose()`. Core defines the **shape** of "run a command somewhere"; it never
  names Docker, containers, or projects.
- Threaded as an **optional injected dependency**: `SessionOptions.sandbox → LoopDeps → ToolContext.sandbox`
  (and into the subagent child loop). `Bash` routes through `ctx.sandbox.exec` **when present**; when absent
  it falls back to the existing host `spawn` — so the **VS Code extension is unchanged** (host exec).
- This is the *only* sanctioned reason to extend core (per the wrapper-architecture rule): a **generic
  capability interface** the wrapper implements, exactly like `ModelProvider`/`Tracer`/`McpConnect`.

**Server (the wrapper owns Docker):**
- `server/src/dockerSandbox.ts` — `DockerSandbox implements Sandbox`: one long-lived `--rm` container per
  project (`docker run -d … -v <projectDir>:/workspace … tail -f /dev/null`), each command a
  `docker exec -w /workspace … sh -c <cmd>` with streamed output; `dispose()` does `docker rm -f`.
  `dockerAvailable()` probes the daemon.
- `ProjectManager` **owns the sandbox per project** (created on `open`, disposed on `delete`/shutdown) and
  injects it into the session via `createSessionFor(dir, sandbox)`.
- `wsServer` injects a `DockerSandbox` factory **when Docker is available**, else `undefined` (host
  fallback) with a visible warning. Opt out with `CASCADE_SANDBOX=off`; image via `CASCADE_DOCKER_IMAGE`
  (default `node:20-alpine`).

## Consequences

- **Core stays pure & portable.** No Docker/container/project concept enters core. The same engine still
  runs host-exec in the extension; the server swaps in isolation purely by injecting a `Sandbox`.
- **Swappable isolation.** `Sandbox` is the abstraction; today it's Docker-shared-kernel (pragmatic for a
  local tool), and gVisor/Firecracker/E2B can replace `DockerSandbox` later with **zero** core/tool changes.
- **Files are confined, not fully isolated (v1).** The project dir is *mounted* into the container, so
  container writes land in the host project dir (that's the editable workspace) — but exec (network, npm,
  arbitrary processes) is contained. Fully-in-container files are a later step.
- **Graceful degradation.** No Docker ⇒ host exec + warning, so the app stays usable for users without
  Docker (a deliberate v1 trade-off for a local, single-user tool; not acceptable once hosted/multi-tenant —
  noted for the future).
- **Subagents inherit it.** The nested loop gets the same `sandbox`, so delegated work is sandboxed too.

## Verification

- Unit (no Docker, deterministic): `Bash` provably routes through an injected fake `Sandbox`, streams its
  output, reports nonzero exit, and degrades gracefully if `exec` throws (`core/test/bash.test.ts`).
- Integration (Docker-gated, `CASCADE_DOCKER=1`, mirrors the live-embeddings test): real `docker exec`,
  commands run in `/workspace`, a file written inside the container appears in the host project dir (the
  isolation boundary), and exit codes propagate (`server/test/dockerSandbox.live.test.ts`) — **4/4 pass**.
- Runtime: the server reports `sandbox: docker` when the daemon is up; a per-project container is created on
  first `Bash`.

## Prior art

Local coding agents commonly spawn a pty session per client — a process boundary, not a container, so
isolation comes from the host account rather than a sandbox. Desktop app builders commonly run generated apps
**directly on the host by default** (`pnpm install && pnpm dev`), with opt-in Docker/cloud modes, accepting host
execution because they are local apps. Cascade differs deliberately: **execution is sandboxed by default**
(Docker per project) behind a generic seam, because the builder runs untrusted model output and we refuse to
weld infra into the headless core.
