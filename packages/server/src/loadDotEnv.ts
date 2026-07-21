// loadDotEnv.ts — zero-dependency .env loading, imported FIRST by wsServer.ts (side-effect import) so
// keys are in process.env before any module-level `process.env.CASCADE_*` const initializes.
//
// Why not dotenv/`process.loadEnvFile`? No new dependency, and loadEnvFile throws when the file is
// missing (we want "absent = fine"). Rules match dotenv's: `KEY=value` lines, `#` comments, optional
// surrounding quotes, and REAL environment always wins — a .env can never override what the shell set
// (so `CASCADE_MODEL=x npm run dev` still behaves as typed).
//
// Search order: cwd (repo root when run from there), then the repo root relative to this file (covers
// `npm run dev -w @cascade/server`, whose cwd is packages/server), then packages/server itself.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const candidates = [
  join(process.cwd(), '.env'),
  join(import.meta.dirname, '..', '..', '..', '.env'), // monorepo root (src → server → packages → root)
  join(import.meta.dirname, '..', '.env'), // packages/server
]

for (const file of candidates) {
  if (!existsSync(file)) continue
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (!m || m[1].startsWith('#')) continue
    let value = m[2]
    if (value.startsWith('#')) value = '' // bare `KEY=` followed by a comment
    const quoted = value.match(/^(["'])(.*)\1$/)
    if (quoted) value = quoted[2]
    else value = value.replace(/\s+#.*$/, '').trim() // strip trailing comment on unquoted values
    if (process.env[m[1]] === undefined) process.env[m[1]] = value
  }
  console.log(`Loaded environment from ${file}`)
  break // first hit wins — one .env, no layered merging to reason about
}
