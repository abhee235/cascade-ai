# The backend (added by the backend pack)

Express + Prisma over SQLite. The frontend reaches it through the Vite dev proxy: the browser calls
relative `/api/...` URLs and Vite forwards them to this server on port 8787. One published port serves
both; no CORS, no ports in the client.

## Adding a collection to the API (the whole recipe)

1. **Model** — add it to `prisma/schema.prisma`, matching your `src/lib/types.ts` interface:
   ```prisma
   model Recipe {
     id       Int     @id @default(autoincrement())
     name     String
     cuisine  String
     favorite Boolean @default(false)
   }
   ```
2. **Migrate** — `npm run db:migrate` (creates the table + regenerates the Prisma client).
3. **Expose it** — add ONE line to `RESOURCES` in `server/index.ts`:
   ```ts
   { path: 'recipes', model: 'recipe' },
   ```
   That gives you `GET/POST /api/recipes` and `GET/PUT/DELETE /api/recipes/:id`.
4. **Seed** — wire your `src/lib/data.ts` array into `prisma/seed.ts`, then `npm run db:seed`.

## Connecting the frontend

The frontend keeps using `createStore` from `src/lib/storage.ts`. To point it at the API, change that
file's factory to the API one (one line — see `src/lib/storage.api.ts`). Views and hooks don't change.

## Running

- `npm run dev` — Vite + API together (one command, via concurrently).
- `npm run build && npm start` — single production Node process serving the built app + API.
