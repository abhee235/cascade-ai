# ADR-069 — Database viewer: a "Database" panel for graduated full-stack apps

Status: proposed (deferred — decide later) · 2026-07-22

## Context

ADR-066 graduates a prototype to a real backend: **Express + Prisma + SQLite**, local-first, running
inside the preview container. Once data lives in a real SQLite file, the user has no way to *see* it —
tables, schema, relationships, or rows. Every comparable product surfaces this. Research (2026-07):

- **Builder A** — a first-class **Database pane**: a SQL runner, a "My Data" spreadsheet, and **Drizzle
  Studio** embedded as the visual manager (browse/edit rows, manage schema/tables/views/enums).
  Postgres (Neon-backed). i.e. they **embed an existing viewer**.
- **Builder B** — **no own viewer**; leans entirely on **its database provider's dashboard** (Table Editor +
  SQL Editor). Schema changes run as **reviewed migrations approved in chat** (writes the SQL, shows it,
  asks approval, then migrates + regenerates types).
- **Builder C** — **no rich in-app viewer**; connects hosted databases via a marketplace,
  **generates + executes SQL in chat**, and defers browsing to the **provider's console**.

**The pattern:** nobody *builds* a viewer — they either embed one (A) or ride a managed provider's
free dashboard (B, C). Cascade can't do the latter: ADR-066 is **local-first SQLite in the
container**, so there is no hosted provider and no free console. That leaves **A's path — embed
an OSS viewer** — plus, worth adopting, **B's approve-migration-in-chat** flow, which Cascade
already has the primitives for (the QuestionCard approval card + ApplyPack).

## Options considered (with licenses — verified 2026-07)

| Tool | License | Embeddable | Capability | Verdict |
|---|---|---|---|---|
| **Outerbase Studio** (`outerbase/studio`) | **AGPL-3.0** (no dual license) | Yes, React | schema + data grid + SQL editor + ERD, SQLite driver model | Richest, but **AGPL network-copyleft** entangles a hosted/closed Cascade |
| **Drizzle Studio embeddable** (`@drizzle-team/studio`) | **Commercial / paid B2B** | Yes | full studio | Not OSS to embed; Drizzle-oriented (we're Prisma) — skip |
| **`sqlite-erd`** (jurerotar) | **MIT** ✅ | **Yes, React component** (`npm i sqlite-erd`) | reads a SQLite file → ERD + schema + **row browsing** (paginated drawer), 100% client-side | **Best drop-in** |
| **`db-schema-toolkit`** (maxgfr) | **MIT** ✅ | parsing lib | parses `schema.prisma`/SQL/DBML → schema model; **schema-only, no rows** | Good for a themed ERD |

## Decision (proposed — not yet accepted)

Add a **Database tab** to the editor panel (`Preview · Code · Versions · **Database**`), shown **only
when the project has graduated** (the backend pack is applied / a `.sqlite` exists). Lean MIT to avoid
license risk. Two build tiers, pick when we implement:

1. **Tier A — schema + rows, minimal build:** embed **`sqlite-erd` (MIT)**. A read-only backend endpoint
   serves the container's SQLite file (or a snapshot); the tab loads it into `<SQLiteERD/>` → ERD +
   schema + row browsing. Ships fast; theming depth (matching our tokens) needs a look.
2. **Tier B — on-theme ERD:** parse `schema.prisma` with **`db-schema-toolkit` (MIT)** → render a custom
   ERD with **React Flow (`@xyflow/react`, MIT)**, fully design-system-matched. Schema-only (no live
   rows). Best if the diagram is the priority.

Optionally layer **chat-approved migrations**: when the model changes the Prisma schema, show the
generated migration SQL in the **approval card** and run it only on approve — reusing ADR-043
(AskUserQuestion) + ADR-066 (ApplyPack).

**Outerbase Studio stays on the table ONLY if** Cascade itself ships AGPL-compatible (open source); it
is the most capable option but the license, not the tech, is the blocker.

## Integration shape (whichever tier)

The SQLite lives inside the preview container, so the tab needs a small **server-side introspection /
query surface** (on the backend pack, or a Cascade-managed read-only route):
- `schema` → `sqlite_master` / Prisma DMMF → tables, columns, foreign keys.
- `rows` (Tier A / data browsing) → **read-only, guarded** paginated selects.
- Tab gating: only render when graduated (pack present).

## Open questions (for the later decision)

- How deeply does `sqlite-erd` theme to our tokens vs. needing a wrapper/fork?
- Serve the live `.sqlite` file to the client, or a periodic read-only snapshot (locking / concurrency
  with the running Express)?
- Do we want *editable* rows (write-back) or read-only visualization first? (Read-only is safer + enough.)
- Migrations-in-chat: own ADR, or folded into ADR-066's ApplyPack flow?

## Explicitly out of scope (this ADR)

Editing data from the UI, multi-DB (Postgres/MySQL) support, hosted-provider dashboards, and the
migration-approval flow's full design — all layerable later; nothing here blocks them.
