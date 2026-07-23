# ADR-070 — Session storage in a database (Supabase / Postgres)

Status: proposed (deferred — decide later) · 2026-07-23

## Context

Cascade's control-plane state — the *chats*, not the built app's data — lives in **files** today, under
each project's `.cascade/` (server host, not the sandbox):

- `chats.json` — the per-project chat index (id, title, timestamps).
- `chat-<id>.json` — a **snapshot** of the flattened `Message[]` conversation. Written only at
  **turn end** (`chatStore.save`).
- `chat-<id>.events.jsonl` — an **append-only replay log** of `ActivityEvent`s (the rich stream: user
  rows, tool start/result with diffs, thinking, memory, compaction). This is what makes reload = live.
- Adjacent host files: `active-model.json`, `models.json` (ADR-067), `traces/*.jsonl` (ADR-023 forensics),
  `todos.json`.

The goal (2026-07-23): **host Cascade as a whole application**, most likely on **Supabase cloud**. That
means moving chat/session state off the local disk and into a managed Postgres, so a deployed instance
has durable, multi-user, queryable storage without shipping a filesystem.

This ADR decides **how** to store a session in a DB. It is informed by two things learned this session:

1. **The durability lessons (the whole reason the two-file model exists).** The snapshot is written only
   at turn end, so a crash mid-turn loses the in-flight turn — the `events.jsonl` is the mitigation, and
   the ADR-068 chat-restore work exists precisely because the snapshot half goes stale during a build.
   Any DB design must **keep** this property, not regress it.
2. **How a mature local coding agent persists a session** (traced 2026-07-23): one
   **append-only JSONL per session**, keyed by `sessionId` under a sanitized-cwd dir; each line a
   transcript message carrying `uuid` + **`parentUuid`** (history is a **parent-linked tree**, not a
   flat list); compaction writes a `compact_boundary` record with `parentUuid: null` that severs the
   backward walk, and the summary is a **separate `{type:'summary'}` record** the loader attaches;
   subagents get **their own files**; a tool_result's `parentUuid` is overridden to its originating
   tool_use so parallel calls stay threaded. The write path is **incremental append, never full
   rewrite**; the load path walks `parentUuid` back from the newest leaf and reverses.

## Decision drivers

- **Don't regress durability.** A network blip to a cloud DB must not kill a running build, and a crash
  must not lose the in-flight turn — the exact properties the local `events.jsonl` gives us today.
- **Hot-path latency.** A single build emits **hundreds of events** (measured: one build's replay log
  hit 499 events / 478 KB). A local append is sub-millisecond; a round-trip to cloud Postgres is
  ~20–100 ms. Appending each event *synchronously* to the cloud would add that latency to every event
  of every turn — unacceptable on the streaming path.
- **Multi-tenancy.** "Host the whole app" implies more than one user. Isolation must be designed in from
  the first migration (Supabase RLS), not retrofitted.
- **Rich stream fidelity.** The `events` log is the source of truth for the UI (reload = live); flattening
  to `Message[]` loses thinking, diffs, and tool status — a lesson already paid for this session.

## Decision (proposed — not yet accepted)

### 1. Postgres via Supabase, `jsonb` payloads, **one row per event** — not one blob per chat

The instinctive "JSON or text column?" question hides a worse assumption: **one row per chat holding the
whole conversation**. Rejected — the events log is append-only and streams live, so a blob column makes
every event a read-modify-write of the entire conversation (O(n²) over a turn, and a live reattach reader
races the writer). Store **one row per event**; each append is then a plain `INSERT` and the column-type
question shrinks to "`jsonb`" (Postgres binary JSON — indexable, queryable; `json`/`text` only if we never
introspect it, which we occasionally will).

```sql
-- One row per chat (replaces chats.json)
create table chats (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id) on delete cascade,
  owner       uuid not null references auth.users(id),   -- RLS pivot
  title       text not null default 'New chat',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index on chats (project_id, updated_at desc);

-- One row per ActivityEvent (replaces chat-<id>.events.jsonl)
create table chat_events (
  chat_id     uuid not null references chats(id) on delete cascade,
  seq         bigint not null,          -- monotonic per chat (replaces JSONL line order)
  ts          timestamptz not null default now(),
  kind        text not null,            -- 'user' | ActivityEvent type ('toolStart', 'message', 'compacted', …)
  parent_seq  bigint,                   -- NULLABLE, unused for now — see "the tree question"
  payload     jsonb not null,           -- the event (or the user text)
  primary key (chat_id, seq)
);
```

The composite PK `(chat_id, seq)` gives ordered reads (`where chat_id = ? order by seq`) for free and
makes append a single indexed insert. `owner` on `chats` (inherited by events via the FK) is the RLS
pivot. Provider/model config (ADR-067) migrates to small `settings`-style rows or stays file/env — out
of scope here.

### 2. Local buffer is the source of truth; Supabase is **write-behind**, not write-through

This is the load-bearing decision.

| Option | Verdict |
|---|---|
| **A. Write-through** — each event `INSERT`s to cloud Postgres synchronously | ❌ adds cloud latency to every event; a network blip or Supabase hiccup stalls or kills the build; loses local crash-durability |
| **B. Write-behind** — the local append (a `.jsonl` or a local SQLite WAL) stays the durable source of truth; a background flusher batches events to Supabase asynchronously | ✅ **recommended** — preserves sub-ms hot path and crash-recovery; a network outage degrades to "not yet synced", never "build dead" |
| **C. Local SQLite mirror + logical sync** | more moving parts than B buys us until offline-first is a real requirement |

Concretely (B): the agent keeps appending to the local `events` log exactly as today (that is what
guarantees a mid-turn crash loses nothing). A `SupabaseSink` drains new rows in the background — batched,
retried, resumable from the last synced `seq` — so the cloud is an eventually-consistent replica. On a
fresh host with no local file, reads fall back to Supabase directly. This keeps ADR-068's whole
turn-restore story intact and makes the cloud DB a **sync target, not a dependency of the running agent**.

### 3. Compaction and the tree — carry the traced design's lessons across

- **Compaction as a row, loader stops at it.** Write a `chat_events` row with `kind = 'compacted'` whose
  payload holds the summary, and make the load path **replay only events after the last compaction row** —
  otherwise reload re-feeds the model the full pre-compaction history we just paid to summarize away
  (the traced `compact_boundary` + separate `summary`, generalized). Cascade already emits a `compacted` event,
  so this is mostly a loader rule.
- **The tree question (needs a decision).** The traced design stores `parentUuid` and reconstructs the *active branch*.
  Cascade is linear today. `parent_seq` is included **nullable and unused** as cheap insurance: if
  Cascade ever adds **message edit / rewind / "retry from here"** — plausible for a production-grade tool —
  a flat `seq` log cannot represent the fork, and adding the column to a populated table later is
  painful. **Open question below.**

### 4. Multi-tenancy via RLS from day one

`owner uuid references auth.users(id)` on `chats`, and Supabase Row-Level Security policies so a user only
sees their own chats/events. This is why Supabase is attractive beyond "a hosted Postgres" — auth + RLS +
migrations come in one box. Designing the pivot column in now avoids a painful backfill.

### 5. What does NOT go into Postgres

- **OTel forensic traces** (`traces/*.jsonl`) — one hit **34 MB**. These belong in Phoenix / object
  storage / files, not a relational row store. Keep them out.
- The **built app's** own data (ADR-066 ApplyPack: Express + Prisma). That app may *also* use Supabase,
  but that is the *user's* database for *their* app — entirely separate from Cascade's control-plane
  chat storage. Do not conflate the two connections.

## Migration path

1. Land the schema behind a `CASCADE_STORAGE=supabase` flag; `chatStore` keeps its file API and gains a
   sink. Files remain the default and the local durable buffer.
2. One-time importer: walk existing `.cascade/chats.json` + `chat-<id>.events.jsonl` → `chats` +
   `chat_events`, deriving `seq` from line order.
3. Flip hosted deployments to Supabase-backed reads; keep local-dev on files (no cloud dependency to run
   the repo).

## Open questions (decide before implementing)

1. **Fork / rewind?** If Cascade will ever let a user edit or retry from an earlier message, `parent_seq`
   becomes load-bearing and the loader must walk it (bigger design). If never, `seq` ordering suffices and
   `parent_seq` stays insurance. **This changes the design — settle first.**
2. **Realtime.** Supabase can push on `chat_events` insert. Tempting as a multi-tab/multi-device sync
   channel, but the live turn already streams over the WebSocket (ADR-068) with lower latency. Likely
   *additive* (cross-device catch-up), not a WS replacement — but confirm before relying on it.
3. **Offline dev.** Does `bun scripts/dev.ts` need to run with no Supabase reachable? If yes, files must
   stay a first-class backend, not just a migration source (argues for keeping option B's local buffer
   permanently, not as a stopgap).
4. **Traces + config.** Confirm traces stay out of Postgres and decide whether ADR-067's `active-model` /
   `models` config moves to a `settings` table or stays file/env.

## Out of scope

Auth UI, Supabase project provisioning, the DB **viewer** (ADR-069 — that is about showing the *built
app's* SQLite, a different concern), realtime as a WS replacement, and any change to how the built app
persists its own data (ADR-066).
