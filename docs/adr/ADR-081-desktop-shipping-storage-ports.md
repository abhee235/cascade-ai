# ADR-081 — Shipping Cascade as a native desktop app: storage ports, host/docker runtime, embedded telemetry

> **Status:** accepted, implementation in progress. Branch `desktop-shipping`.

## Context

Cascade runs today as a local web app: a Node server (`packages/server`) + a browser UI
(`packages/web`), with Docker required for the sandbox and Phoenix (a Python container) for traces.
The product needs to ship as a **native OS binary** — that is the reachable distribution channel now;
a hosted web app is the eventual destination but needs money and operational resources first.

So the constraint is explicit: **build for desktop today WITHOUT foreclosing web tomorrow.** Every
desktop-specific decision has to sit behind a seam a hosted deployment can swap.

Prior art surveyed across shipped Electron developer tools: the common shape is Electron Forge +
Vite for packaging, an embedded SQLite file with migrations applied in-process at launch, an
OPTIONAL container runtime rather than a required one, and analytics gated by an explicit consent
check at send time rather than at init.

## Decisions

### 1. SQLite for state — NOT Prisma

SQLite is right for an embedded single-user store. **Prisma is not**: it ships a native query-engine
binary per platform (~15–20 MB each), must be unpacked outside `asar` and path-resolved at runtime
(a classic "works in dev, broken when packaged" failure), and wants its CLI for migrations. That
alone would exceed the whole bundle target.

- **Driver:** prefer **`node:sqlite`** (built into Node 22.5+, which Electron ships) — ZERO native
  dependencies, so no per-platform rebuild, no prebuild matrix, no asar unpacking. It is still
  flagged experimental; fall back to `better-sqlite3` if the API bites.
- **Query layer:** Drizzle is a fine default but is not assumed. For a ~6–8 table schema, **Kysely**
  (type-safe, no codegen, no runtime engine) or plain SQL with a hand-rolled migration table is
  lighter. Decide when the schema is written, not before.
- **Migrations run in-process on launch.** A shipped binary must self-migrate; there is no operator
  to run a migration step, and a half-migrated install is a support ticket we cannot debug remotely.

### 2. Files stay files — this is a HYBRID, not a migration to a database

Project source, `PLAN.md` and `.cascade/` stay on disk. They are the product: the user edits them,
`VersionManager` git-checkpoints them, and `npm install` needs a real filesystem. Moving them into a
DB would break versioning outright.

Moved to SQLite: **chat metadata + transcript/replay log, project registry, model config, connector
config, traces.** These are the things we currently discover by scanning directories; a DB buys
search, cross-project queries, atomic writes, and no half-written JSON after a crash.

### 3. Writes are NOT write-heavy — batch, do not queue

Measured shape: a busy turn writes **hundreds of rows over minutes** (one replay entry per relayed
event, one row per span). Even the pathological 114-turn session was a few thousand rows across ~40
minutes. "Write-heavy" means sustained thousands of inserts per SECOND; SQLite does ~50k/s batched.
We are three orders of magnitude below anything that stresses it, so a queue system (worker process,
BullMQ) would add process boundaries, serialization, backpressure and crash/replay semantics to solve
a problem we do not have.

What actually costs is the **commit/fsync**, not the insert. So:

- **Buffer + flush inside ONE transaction** (~150ms or ~100 rows). 10–100× faster than per-row commits.
- **`journal_mode=WAL` + `synchronous=NORMAL`** — kills the fsync-per-commit stall, and lets the
  Traces UI read while a turn writes. WAL is chosen for CONCURRENCY, not throughput.
- The agent loop already never awaits the DB: `tracer.event({…})` is fire-and-forget. A `SqliteTracer`
  pushes into the buffer and returns.
- **Escape hatch:** if traces ever show a real stall, move SQLite into a `node:worker_threads` worker
  behind the same interface. Far less machinery than a queue, and a drop-in because DB access sits
  behind a module boundary from day one.

### 4. Runtime: `host | docker`, defaulting to `host`

Requiring Docker is install friction that kills desktop adoption — the app must be useful the moment
it is installed, with isolation available to those who want it:

- **host** — the agent's tools run as local child processes. **The path jail already exists**
  (`resolveInProject(cwd, path, sandbox?.root)` throws `ProjectPathError`, ADR-033) and works off
  `cwd` with no sandbox, so a Docker-free mode is mostly wiring, not new machinery.
- **docker** — opt-in, the existing `DockerSandbox`, for users who want real isolation.

**Stated plainly, not discovered later:** the path jail constrains FILE tools, not `Bash`. In host
mode the agent runs `npm install` and generated build scripts directly on the user's machine. This is
the same trade every local developer tool makes for a machine the user owns (an editor's task runner
and extensions have identical reach). Docker mode is the answer for anyone who wants more. Recorded
here so it is a deliberate trade and never an accident.

### 5. Telemetry: embedded, not bundled

Phoenix is a Python service; bundling it means shipping a Python runtime and blows the bundle target.
Instead:

- **`SqliteTracer`** — a third `Tracer` implementation beside `JsonlTracer`/`OtelTracer`. The seam
  already exists (`fanout`), so this is additive, not a refactor.
- **An in-app Observatory** — trace list, waterfall, span detail, stats. We have leaned on traces to
  diagnose nearly every weak-model failure this cycle; that makes it a product feature, not dev
  tooling. UI ported from the author's `headlessos` repo
  (`client/src/components/Observatory/`: `TraceListView`, `TraceDetailView`, `TraceTree`,
  `SpanDetailPanel`, `SpanKindIcon/Token`, `StatsPanel` — tests included).
- **OTLP stays an opt-in escape hatch** via `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, so power users can
  still point at their own Phoenix. Bundle cost of telemetry: ~0.

### 6. Ports and adapters — the web-tomorrow guarantee

New packages:

```
packages/storage/          PORTS (interfaces) + shared types
packages/storage-sqlite/   desktop adapter
packages/storage-postgres/ ← later, web adapter
packages/desktop/          Electron main + forge config + makers
```

| Port | Desktop | Web (later) |
| --- | --- | --- |
| `ChatStore` | SQLite | Postgres |
| `ConfigStore` (models, connectors) | SQLite | Postgres, per-user rows |
| `TraceStore` | SQLite | Postgres / ClickHouse |
| `BlobStore` (screenshots, uploads) | local fs | S3/R2 |
| `Sandbox` *(already exists)* | host process **or** Docker | remote container |

Project files need no new port: they are already behind `Sandbox`, and they must remain real files in
every deployment (git, edits, installs). `HostSandbox` simply joins `DockerSandbox`.

**The rule that keeps this honest:**

> `packages/server` must not import `node:fs`, `better-sqlite3`, or `electron`.

Everything arrives by constructor injection — exactly how `mcpConnect` and `sandboxFor` already work.
Enforced mechanically by `packages/server/test/storageBoundary.test.ts` rather than by discipline: a
test (not a lint rule) because there is no root biome config to hang one on, and because a test fails
the suite while keeping the exemption list explicit and reviewable. It carries two sets — files that
still owe a port (shrinking that list IS the migration) and files that touch the PROJECT's files,
which stay real files in every deployment. The test of the abstraction: **writing the Postgres adapter
should require zero changes to `server`.**

`packages/desktop` stays thin — boot the existing server in-process, open a `BrowserWindow` on the
built `web` bundle, wire auto-update. Any logic that lands there will not exist on web.

## Consequences

- Ships as a native binary (Squirrel/`.exe` on Windows, signed+notarized zip on macOS) with no Docker
  and no Python required to run.
- The known leaks to fix are small and concrete: `chatStore`, `modelRegistry` and `mcpRegistry` write
  JSON with `readFileSync`/`writeFileSync` directly. Doing this now, while they are small, is why the
  ordering below starts with storage.
- Host mode trades sandbox isolation for install-friction. Recorded in §4.
- `node:sqlite` being experimental is a real risk; the fallback is a one-line driver swap because DB
  access sits behind a port.

## Implementation order

1. `packages/storage` ports + the boundary test.
2. `TraceStore` + `SqliteTracer` + buffered writer — smallest surface, immediately useful, validates
   the pattern on something low-risk.
3. Observatory UI ported from `headlessos`.
4. `ConfigStore` (`modelRegistry`/`mcpRegistry` are nearly ports already).
5. `ChatStore` + a file→SQLite migration for existing chats.
6. `HostSandbox` + the `runtimeMode` setting and its UI.
7. `packages/desktop` (Electron Forge, makers, signing, auto-update).
