# ADR-066 — Progressive full-stack: prototype-first, backend pulled in on demand

Status: accepted · 2026-07-21

## Context

Cascade apps prototype frontend-only (Vite/React + localStorage). When a user asks for a
backend/database/auth, the model had to hand-improvise the whole migration — the gpt-5.6-luna run did
exactly this (localStorage → JSON API → SQLite → Prisma, offline-first) and succeeded, but only because
it's a frontier model, and it fought our infra (orphaned processes, stale servers, single-port preview).
Research (three hosted app builders, 2026-07): **none ask prototype-vs-production — all infer**, and each
ships an opinionated stack (Next.js; Vite + a hosted backend; **Vite/React + Express** — our shape).
Their weakness is backends "stitched from third-party cloud services rather than compiled from one
plan." Cascade's opening: **local-first graduation** — start light, pull in a prepared, interoperable
backend mechanically when asked, without rewriting the frontend. Weak-model-friendly because the pack
ships working code; the model only applies, swaps one seam line, and extends.

## Decision

**The seam (base template).** `src/lib/storage.ts` ships a `createStore<T>(key, seed)` collection store
(list/get/create/update/remove/replaceAll), localStorage-backed. All collection data goes through it —
never raw localStorage in views. Cost to prototypes: one small file; payoff: graduation-ready by
construction. The data + architecture skills teach it; a `/api` proxy is pre-added to the template's
vite.config (inert until a backend exists).

**The pack (on-demand).** `templates/react/packs/backend/` holds the graduation layer — Express +
Prisma + SQLite server, `prisma/schema.prisma`+`seed.ts`, `storage.api.ts` (the API-backed twin,
`ApiStore extends Store`, offline-first), and `package.pack.json` (deps/scripts fragment). `applyTemplate`
EXCLUDES `packs/`, so a fresh project is frontend-only. `applyPack` copies the files and MERGES the
fragment into package.json (pack entries win — the `dev` script deliberately becomes `concurrently`
web+api — never clobbering the whole file).

**Model-callable, self-gating.** `ApplyPack` is a server-owned extra tool (injected like the Browser
tool) that runs `applyPack` and returns the exact next steps. Advertised ONLY while an un-applied pack
exists (`isPackApplied` marker = `server/`), so it vanishes after graduation and can't double-apply.
Graduation is mechanical: ApplyPack → npm install → add model + migrate → add one RESOURCES line → seed
→ swap ONE re-export in storage.ts (`createApiStore as createStore`) → build. Frontend views/hooks never
change — that's the interoperability contract.

**Infer, don't interrogate.** The planner infers backend need from the request (persist-on-server,
accounts, multi-user, API → a terse **Backend** section; else "no backend" in Out of scope), with the
no-new-deps rule gaining a pack exception. BUILDER_BEHAVIOR + the new `backend` skill route all backend
requests through ApplyPack, never hand-rolled.

**Stack rationale (measured/derisked in THIS sandbox).** Express 4 + Prisma 6 + SQLite + tsx +
concurrently: Prisma 6 migrate/seed worked in the luna run (Prisma 7 config incompatible — pinned);
better-sqlite3 can't build (no node-gyp) — Prisma's engines can; Express for maximal weak-model prior;
MongoDB rejected (needs mongod, breaks local-first). **Next.js rejected as default** on evidence: App
Router's server/client boundary is a documented LLM failure zone, and our whole stack (loc-stamp Babel
plugin, designLint, skills, evals) is Vite-shaped; a `nextjs` template stays possible later via the
additive template registry. Single-deployable prod without Next.js: the pack's `start` script serves the
built `dist/` from Express (one Node process in prod; two behind one command in dev).

**Process hygiene.** PreviewManager + the Browser tool reap stale `vite`/`tsx server` processes before
starting dev — fixes the measured orphan accumulation across submits.

## Files

Base: `templates/react/src/lib/storage.ts` (new), `vite.config.ts` (/api proxy), skills
`data/SKILL.md` + `architecture/SKILL.md`. Pack: `templates/react/packs/backend/**`. Machinery:
`src/templates.ts` (listPacks/applyPack/isPackApplied + packs exclusion), `src/packTool.ts` (new),
`src/projectManager.ts` (inject + BUILDER_BEHAVIOR), `src/previewManager.ts` + `src/browserTool.ts`
(reaping), skill `backend/SKILL.md` (new), `agents/builder/planner.md` (Backend section).

## Verification

Unit (13 new in templates.test.ts): packs excluded from fresh projects; the seam DOES ship; listPacks;
applyPack copies files + merges package.json without clobber (base deps/scripts preserved, pack `dev`
wins, Prisma pinned ^6); unknown-pack throws; seam↔API drop-in parity (ApiStore extends Store, same
contract methods). Suite 435 green, core/server/web typechecks clean.

**Eval scenario `builder-graduate`** (eval/builder/builder-graduate/): a two-prompt iterate — build an
"Inkwell" notes prototype that persists via the seam, then graduate it to a real backend. The check is
OFFLINE by construction (only `vite build` — `server/` is outside the frontend tsconfig and never
installed): asserts the frontend still builds after graduation, the pack was applied (server/ + prisma/
+ storage.api present, not hand-rolled), a real Prisma model + an /api resource exist, the seam was
swapped to `createApiStore`, and NO view touches raw localStorage. The eval session now injects the
ApplyPack tool (a fidelity gap it was missing). `--verify` sound (seed fails, solution passes) across
all 5 scenarios. NOTE: a full graduation RUN where the model also executes `npm install`/`prisma
migrate` needs those pack deps pre-installed in the shared bench node_modules (express, prisma@6, tsx,
concurrently) — the offline check does not require them.

**Pending (held):** live proof on the local 36B — fresh Simmer prototype → "persist on a server with a
database" → expect backend skill → ApplyPack → migrate/seed → seam swap → dev (no orphans) → API smoke;
count wasted turns vs the luna baseline.

## Out of scope (layerable later)

Auth pack (Prisma User + bcryptjs + cookie session + Login view — Phase 3), Supabase/Postgres, a
first-class `nextjs` template, deployment story.
