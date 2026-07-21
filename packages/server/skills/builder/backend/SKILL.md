---
name: backend
description: Graduate a prototype to a real backend (database, server API, persistence across users/devices) using the ApplyPack tool — never hand-write a server.
whenToUse: Load when the user asks to persist data on a server, add a database, build a backend/API, save data across devices or users, or anything that outgrows browser localStorage.
---
# Backend — graduate the prototype, don't hand-roll it

The app persists in the browser (localStorage) via the `createStore` seam. When the user wants a REAL
backend — a database, a server, data shared across devices — you do NOT write a server, Prisma config,
or migration by hand. There is a prepared, tested pack for exactly this. Hand-rolling it is the wrong
move (it wastes turns and gets the env details wrong — native builds, Prisma versions, ports).

## The graduation checklist — one tool call per step, in order

```
- [ ] 1. ApplyPack {pack: "backend"}          — copies server/, prisma/, storage.api into the project
- [ ] 2. Bash: npm install                     — big timeout (240000); installs express, prisma, tsx…
- [ ] 3. Add model(s) to prisma/schema.prisma  — match src/lib/types.ts; then Bash: npm run db:migrate
- [ ] 4. Add each collection to RESOURCES in server/index.ts (one line: { path, model })
- [ ] 5. Wire src/lib/data.ts seeds into prisma/seed.ts, then Bash: npm run db:seed
- [ ] 6. Swap the seam: in src/lib/storage.ts, re-export createApiStore as createStore (ONE line)
- [ ] 7. Bash: npm run build  — verify green. The dev server now runs BOTH processes.
```

Read `server/README-server.md` (the pack drops it in) for the route-adding recipe and details.

## The seam swap (step 6) — why the frontend doesn't change

`src/lib/storage.api.ts` (from the pack) exports `createApiStore` with the SAME interface as
`createStore`. In `src/lib/storage.ts`: **KEEP the `Entity` and `Store` interfaces at the top** (the API
store imports those types from here) and **replace ONLY the `export function createStore…{ … }` body**
with a re-export of the API factory:

```ts
export interface Entity { id: string | number }   // ← keep
export interface Store<T extends Entity> { /* … */ }  // ← keep (storage.api imports these)

// was: export function createStore<T…>(…) { …localStorage… }   ← delete the whole function
export { createApiStore as createStore } from './storage.api'   // ← add this one line
```

Every view/hook keeps importing `createStore` from `@/lib/storage` — unchanged. Call `store.refresh()`
on mount (in the hook's `useEffect`) to pull the latest from the API.

## Rules

- **NEVER hand-write a server, `prisma/schema.prisma`, or a migration** — ApplyPack ships them. Your job
  is to add the app's specific models/routes/seeds to the prepared files.
- Model field names should match `src/lib/types.ts` so data passes straight through.
- Ids: `@id @default(autoincrement())` Int for local data, or String `@default(cuid())` if the frontend
  makes ids. `favorite Boolean @default(false)` etc. for optional fields.
- The frontend calls relative `/api/...` URLs (the Vite proxy forwards them to the server) — never a
  hardcoded `http://localhost:8787` in the client.
- Auth, multi-user accounts: a separate concern layered on top — say so and keep this step to persistence.
