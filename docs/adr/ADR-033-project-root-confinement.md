# ADR-033 — Unified, confined project root (host ↔ sandbox path reconciliation)

## Context

Cascade has a **split filesystem**, and the model can't reconcile it:

- **Bash** runs *in the Docker sandbox* — `dockerSandbox.ts` mounts the project at `/workspace`
  (`${projectDir}:/workspace`, `-w /workspace`) and every command is a `docker exec -w /workspace …`. The
  host is never touched ([Bash.ts] routes through `ctx.sandbox.exec`).
- **Read / Write / Edit / Glob / Grep** run *on the host* via `node:fs`, resolving paths against `ctx.cwd`
  (the host project dir). They **never** look at `ctx.sandbox` — the `Sandbox` interface only exposes
  `exec()` + `dispose()`, no file I/O. They worked "by accident" because the host project dir *is* the bind
  mount, so a relative path lands in the same bytes the container sees.

The model is told the **host** cwd ([systemPrompt.ts:29]), but `qwen36-agentic` (and most agentic models)
default to a trained convention — we observed it use **`/app`**. The host file tools honoured that absolute
path blindly: `Write("/app/plan2.txt")` → `isAbsolute` → `writeFile("/app/plan2.txt")` → on Windows
**`C:\app\plan2.txt`** — *outside the project entirely*, and `mkdir(recursive)` even **created `C:\app`**. So
two real problems:

1. **Correctness** — files the agent "created" vanished from the project (landed on the host root).
2. **Confinement** — the "sandboxed" web frontend's file tools could write **anywhere on the host**. The
   Docker sandbox isolates *commands*, not *file I/O*.

Agents that run directly on the user's machine typically confine their file tools through input validation +
the permission system (deny-rules + path expansion). We own a **Docker root the model must reconcile**, so we
hard-jail to the project rather than relying on permission rules.

## Decision

One rule for every file tool: **resolve to a host path inside the project root, or reject.**

- **`resolveInProject(cwd, filePath, sandboxRoot?)`** ([tools/projectPath.ts]) — the single resolver:
  1. an **absolute path already inside** the project → accept as-is (the model echoing the real cwd);
  2. a **container-root alias** prefix (`/workspace`, `/app`, or the sandbox's own `root`) → stripped, so
     `/app/plan2.txt` and `/workspace/src/x` become project-relative;
  3. resolve against the project root and **confine** — anything still landing outside (`..`, `/etc`,
     `C:\Windows`, a foreign drive) throws **`ProjectPathError`**, returned to the model as a tool error so it
     self-corrects (the ADR-007 contract), **never** touching the host.
  Alias-matching is on forward slashes (the model writes POSIX paths even on Windows); confinement uses
  `path.relative` (handles `..`, Windows drives, case). Step (1) runs *before* alias-stripping so a host cwd
  that itself lives under `/app` is never double-rooted.
- **`Sandbox.root`** ([sandbox/sandbox.ts]) — the interface now declares the in-sandbox mount point;
  `DockerSandbox.root = '/workspace'`. Core stays Docker-agnostic: it only knows "the sandbox calls the
  project *this*", and treats it as a synonym for the project root.
- **System prompt** ([systemPrompt.ts]) — when sandboxed, the working directory shown to the model is
  `sandboxRoot` (`/workspace`) so its view matches where Bash actually runs; either way it's told to
  *"address files by paths relative to the working directory … Paths outside the project are rejected."*
  `loadMemory` still reads from the host cwd.
- **`displayPath(cwd, abs)`** — the Write/Edit cards show the **project-relative** path (`plan2.txt`), not the
  alias the model used (`/app/plan2.txt`), so the UI reflects where the file actually lives.

Wired through `ToolContext.sandbox?.root` into all five file tools; `Bash` is unchanged (it already routed
through the sandbox).

## Consequences

- **Cascade never touches the host outside the project**, in *both* deployments: web/server (sandbox →
  `/workspace` aliased to the host project dir) and the extension (no sandbox → the opened workspace folder).
- The model can use `/app`, `/workspace`, the host path, or relative — all land in the project; genuine
  escapes are rejected with a self-correcting error.
- We did **not** route file I/O through `docker exec`: the bind mount already makes host writes appear in the
  container at `/workspace`, so host `node:fs` (fast) + confinement is enough. A *remote* sandbox with no bind
  mount would need file ops on the `Sandbox` interface — noted, not built.

## Verification

- **Tool surface (headless, 15/15):** drove the real `Write/Read/Edit/Glob` `.call()` with a `sandbox.root`
  stub — `/app/plan2.txt` & `/workspace/src/x` land in the project; `../`, `/etc/…`, `C:\Windows\…` rejected;
  Read→Edit via the `/app` alias mutates the *project* file; `C:\app` never created.
- **Live app (qwen36-agentic + Docker):** re-ran the file scenario that previously escaped. The model **again
  used `/app/plan3.txt`** (Read card shows it), but the file landed in the project — visible in the Code-pane
  tree and on disk (`alpha / BETA / gamma`), the Write/Edit cards show the clean `plan3.txt`, one `Tasks 3/3`
  card, clean summary, and **`C:\app` does not exist**.

## Follow-ups

- C4 Bash cd-escape check — reset the in-sandbox cwd if a command escapes `/workspace` (pairs with this).
- Remote (non-bind-mount) sandbox → add file I/O to the `Sandbox` interface.
