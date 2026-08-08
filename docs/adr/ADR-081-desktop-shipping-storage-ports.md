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

**The composition root.** `packages/server/src/main.ts` is the process entry point and the ONE file
allowed to name a backend: it opens the DB, builds the per-session tracer, and passes both to
`start(deps)` in `wsServer.ts`, which no longer self-starts (a second entry point would silently
produce a server with no storage wired). A hosted deployment adds a sibling `mainCloud.ts`; nothing
below it changes. `ProjectManager` takes a `sessionTracerFor` factory — the same injection shape as
`sandboxFor` and `mcpConnect` — and `tracerFor` appends its result to the existing fanout, with the
JSONL tracer still first so neither a dead viewer nor a throwing adapter can cost us the forensic
record.

**One fold, two sinks (amended 2026-08-07).** The Observatory originally had its own event→span mapping
beside `OtelTracer`'s. Feeding both from a single replay and diffing measured the cost: **six** event
types reached Phoenix and were dropped by the Observatory (`delegate_nudge`, `plan_nudge`,
`degenerate_cut`, `planning_stall`, `hook`, `permission`); **three** reached the Observatory and were
dropped by Phoenix (`narration_loop`, `repeat_call`, `tool_cap` — the newest breakers, which
`otelTracer` had no `case` for); and the Observatory carried no LLM prompt, no reasoning, no prefill
throughput, no arg-repair or model-load signal. None of it was a bug anyone wrote; it is what two
parallel implementations of one mapping do.

The mapping now lives once in `core/observability/spanFold.ts` and a tracer is a **sink**: `OtelTracer`
turns spans into OTLP, the desktop passes `traces.record` directly. `storage-sqlite` lost its tracer
entirely — the adapter no longer knows anything about the agent, which *strengthens* the boundary.

*Why not OTLP end-to-end, with the desktop consuming its own exporter?* Two reasons, both about the
transport rather than the mapping: OTLP exports a span only when it **ends**, so a turn in flight is
structurally invisible — and watching a live build is the point; and consuming it locally would mean
running an OTLP **receiver** (protobuf decode, a listening socket) inside a desktop app. Sharing the
fold gets the consistency without either cost. Spans are emitted twice — on open and on close — and
each sink decides: an upserting store takes both, OTLP ignores the open.

**The Observatory is pull-based.** A build writes hundreds of spans a minute; pushing them would flood
the socket to render a page nobody may have open. The client polls (3s) *only while the page is mounted*
— which is also what makes a running turn watchable, since spans are readable the moment they are
flushed. Two commands (`traces`/`trace`) and two events; the server filters out traces whose project was
deleted, because a row you cannot open is worse than no row.

**ConfigStore landed (2026-08-08).** `modelRegistry` and `mcpRegistry` were three JSON files written with
`writeFileSync`; they now read and write through the port, and the boundary test's exemption list is down
from three files to one (`chatStore.ts`). Two decisions worth recording:

- **The read API stayed SYNCHRONOUS.** Every getter is called from a request handler or a session factory
  — `enabledMcpServers` is a thunk handed to `createSession` — so making them async would ripple through
  ~20 call sites to buy nothing. These were already in-memory caches over a file; only the backing store
  changed. The load happens once at startup (awaited), and writes are fire-and-forget, exactly as the
  unawaited `writeFileSync` was.
- **Documents, not a table per concept.** Nothing queries this config: every read is "all the models" or
  "all the connectors", the sets are tens of rows, and the shapes are still moving (ADR-067/076/077). A
  JSON document per key keeps a shape change from being a schema change, and keeps the import from the
  old files to a copy.

An existing install's config is imported ONCE at startup, guarded by a marker setting. The first version
guarded on "is the store empty?" — a different question: delete every model and the store is empty again,
so the next launch would import them back. A test caught it.

**Payloads are stored WHOLE (2026-08-07).** Input/output were capped at 4000 chars on the theory that
viewers truncate anyway. That theory is wrong for what these traces are FOR: a prompt cut mid-array
cannot answer "what was the model looking at", and a `Write` cut mid-file cannot answer "what did it
write". The LLM span also carries the **full** message list now, not the last two.

The cost is real and measured — a 30-call turn is **~3.1 MB** of span JSON, so ~60 MB/day at 20 turns
and ~0.8 GB at the 14-day default retention. That lands on a local DB with a retention knob, which is
the right place for it. Two consequences handled rather than absorbed:

- **Sinks cap themselves.** OTLP crosses a network to a collector with its own limits, where an oversized
  span is rejected *entirely* rather than shortened — so `otelTracer` keeps a 32k cap of its own. This is
  exactly what the one-fold-two-sinks split is for.
- **The tree fetch trims; the detail fetch does not.** `traceSpans` repeats every 3s while a trace is
  open, so shipping full prompts there would push megabytes per tick down a socket also carrying a live
  build. It sends 400-char previews flagged `trimmed`, and the detail pane fetches the single span it is
  showing via `span(spanId)`.

The system prompt sits on the AGENT root, once — identical across a turn's calls, it was ~480KB of
duplication per turn (12% of the total) and it belongs to the agent rather than to one of its calls.

**A sub-agent nests; it does not fork the trace (2026-08-07).** The orchestrated plan stage used to be a
SECOND trace for the same user message — an artifact of the planner having its own session and therefore
its own tracer, not a decision. The conventions are clear: OTel's GenAI semconv models a same-process
agent invocation as an INTERNAL `invoke_agent` span, general OTel rules make a nested operation a child
span, and Langfuse/LangSmith propagate trace ids across SERVICE boundaries specifically to keep one tree.
A model-invoked `Subagent {agent:"planner"}` already nested (it shares the parent's tracer); the
orchestrated path now matches via `SpanTracer.subAgent()`, with the server calling `beginTurn()` before
the plan stage so there is a root to nest under and the builder's own submit ADOPTS it.

    agent (builder)          ◀ one user message, one trace
      ├─ agent (planner)     ◀ INTERNAL invoke_agent
      │    ├─ llm turn 0
      │    └─ tool Write PLAN.md
      ├─ llm turn 0 … 2
      └─ tool Write …

**Conversations are the default view (2026-08-07).** A trace is one TURN — Phoenix, LangSmith and
Langfuse all model it that way, and so do we. The consequence is that building one app produces dozens
of traces, and a flat list of them answers "what happened in some turn" while burying "what did this
build do". All three tools solve this with a grouping layer keyed on a session id (Phoenix *Sessions*,
LangSmith *Threads*, Langfuse *Sessions*), and all three lead the group row with **first input → last
output**, because that identifies a conversation far better than an id. `listSessions` is ours, and it
leads rather than sitting in a side tab: for Cascade the conversation IS the unit of work. The flat
"All turns" view stays one click away — it is what you want when hunting *across* history.

Corollary: a turn row is titled by its own **prompt**, not by the root span's name. Every root is called
`agent (builder)`, so a list titled by name is a column of identical rows.

**Beyond a viewer (2026-08-07).** A per-trace view answers "what happened in this turn" and structurally
cannot answer "is this the third time Bash failed this way". So `TraceStore` gained `searchSpans` (a
cross-trace span query) and `listTraces` gained filters — errors-only, project, model, and free text over
the user's own prompt. Trace filtering happens in `HAVING`, not `WHERE`: a trace is an aggregate, and
filtering its rows corrupts its own span count and duration. Paging uses a keyset cursor
`(startedAt, traceId)` — the tie-break is load-bearing, since turns share a millisecond routinely
(measured: 150 traces paged out as 136 without it). A trace is deep-linkable at `/observatory/<id>` and
carries its `chatId`, so the Observatory is not a dead end.

**Running is not a status.** A trace carries `status` (ok/error) *and* `running` separately: a turn can be
in flight and already carrying a failed tool call, and collapsing the two hides one or the other. A
running trace reports **no** `durationMs` — the closed spans' extent reads as a suspiciously fast turn.
Verified live: before this, every in-flight build showed a green tick and a plausible duration.

**A trace is a TURN, not a session.** `SqliteTracer` mints a fresh trace id on every `submit`. The
tracer's lifetime is the session's (it holds that session's open spans), and a session lives for days —
without this, turn 40 appends to turn 1's trace and the Observatory shows one unreadable row with 40
roots instead of 40 waterfalls. `traceId` stays pinnable for tests and backfill.

**The rule that keeps this honest:**

> `packages/server` must not import `node:fs`, `better-sqlite3`, `electron`, or `@cascade/storage-sqlite`
> — outside `main.ts`.

Everything arrives by constructor injection — exactly how `mcpConnect` and `sandboxFor` already work.
Enforced mechanically by `packages/server/test/storageBoundary.test.ts` rather than by discipline: a
test (not a lint rule) because there is no root biome config to hang one on, and because a test fails
the suite while keeping the exemption list explicit and reviewable. It carries three sets — the
composition root, files that still owe a port (shrinking that list IS the migration), and files that
touch the PROJECT's files, which stay real files in every deployment. It also asserts the *inverse*:
that `main.ts` still composes. Without that, deleting the wiring would pass every test and simply ship
a desktop app with an empty Observatory. The test of the abstraction: **writing the Postgres adapter
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
