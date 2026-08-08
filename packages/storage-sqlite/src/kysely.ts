// kysely.ts — one Kysely instance per database handle.
//
// Both stores build queries against the same connection, and a Kysely instance is a thin wrapper around a
// dialect, so constructing one per store is harmless but pointless — and it makes "which instance owns
// this handle" a question nobody should have to ask. Cached by handle so the answer is always "the one".

import { Kysely } from 'kysely'
import type { Db } from './db.js'
import { NodeSqliteDialect } from './nodeSqliteDialect.js'
import type { Database } from './schema.js'

const cache = new WeakMap<Db, Kysely<Database>>()

export function kyselyFor(db: Db): Kysely<Database> {
	let k = cache.get(db)
	if (!k) {
		k = new Kysely<Database>({ dialect: new NodeSqliteDialect(db) })
		cache.set(db, k)
	}
	return k
}
