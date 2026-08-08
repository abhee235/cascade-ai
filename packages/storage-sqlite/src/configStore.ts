// configStore.ts — models, connectors and settings in SQLite (ADR-081 §2).
//
// These were three JSON files written with writeFileSync. That is fine until it isn't: a crash mid-write
// leaves half a file, and half a `models.json` is a picker that has lost your models. A transaction
// cannot do that.
//
// Stored as DOCUMENTS (one JSON value per key) rather than a table per concept, deliberately. Nothing
// queries these — every read is "give me all the models" or "give me all the connectors", the sets are
// tens of rows, and the shapes still change as ADR-067/076/077 evolve. A document keeps the migration
// from the JSON files to a copy, and keeps a shape change from being a schema change.
//
// The SQL is built with KYSELY rather than written by hand (ADR-081, amended 2026-08-08). Two statements
// do not need a query builder on their own merit — but they are the smallest place to prove the custom
// node:sqlite dialect works end to end, and this file is what a second adapter copies first. The upsert
// below is the interesting case: Kysely compiles `onConflict` to the target dialect's own syntax, so the
// Postgres build of this file is the same source with a different dialect passed to `openDb`.

import { Kysely } from 'kysely'
import type { ConfigStore, ConnectorRecord, ModelRecord } from '@cascade/storage'
import type { Db } from './db.js'
import { NodeSqliteDialect } from './nodeSqliteDialect.js'
import type { Database } from './schema.js'

type ActiveModel = { provider: string; model: string; baseUrl?: string }

const MODELS = 'models'
const ACTIVE = 'activeModel'
const CONNECTORS = 'connectors'

export function createConfigStore(db: Db): ConfigStore {
	const k = new Kysely<Database>({ dialect: new NodeSqliteDialect(db) })

	const read = async <T>(key: string): Promise<T | undefined> => {
		const row = await k.selectFrom('config').select('value').where('key', '=', key).executeTakeFirst()
		if (!row) return undefined
		try {
			return JSON.parse(row.value) as T
		} catch {
			// A corrupt value must not take the app down — it reads as "unset", which is recoverable.
			return undefined
		}
	}

	const write = async (key: string, value: unknown): Promise<void> => {
		await k
			.insertInto('config')
			.values({ key, value: JSON.stringify(value) })
			.onConflict((oc) => oc.column('key').doUpdateSet((eb) => ({ value: eb.ref('excluded.value') })))
			.execute()
	}

	const models = async () => (await read<ModelRecord[]>(MODELS)) ?? []
	const connectors = async () => (await read<ConnectorRecord[]>(CONNECTORS)) ?? []
	const sameModel = (a: ModelRecord, provider: string, model: string) => a.provider === provider && a.model === model

	return {
		async models() {
			return models()
		},
		async upsertModel(m) {
			const list = await models()
			const i = list.findIndex((x) => sameModel(x, m.provider, m.model))
			// MERGE, never replace: the editor sends only the fields it changed, and a naive overwrite would
			// silently drop the endpoint's stored key when someone edits the context window.
			if (i >= 0) list[i] = { ...list[i], ...m, apiKey: m.apiKey ?? list[i].apiKey }
			else list.push(m)
			await write(MODELS, list)
		},
		async removeModel(provider, model) {
			await write(
				MODELS,
				(await models()).filter((m) => !sameModel(m, provider, model)),
			)
		},
		async activeModel() {
			return read<ActiveModel>(ACTIVE)
		},
		async setActiveModel(m) {
			await write(ACTIVE, m)
		},

		async connectors() {
			return connectors()
		},
		async upsertConnector(c) {
			const list = await connectors()
			const i = list.findIndex((x) => x.name === c.name)
			// The documented merge rule (ADR-071): `apiKey` UNDEFINED keeps the stored key — that is what makes
			// "change the host without re-entering the key" work — '' clears it, a string replaces it.
			if (i >= 0) list[i] = { ...list[i], ...c, apiKey: c.apiKey === undefined ? list[i].apiKey : c.apiKey || undefined }
			else list.push(c)
			await write(CONNECTORS, list)
		},
		async removeConnector(name) {
			await write(
				CONNECTORS,
				(await connectors()).filter((c) => c.name !== name),
			)
		},

		async setting<T>(key: string) {
			return read<T>(`setting:${key}`)
		},
		async setSetting(key, value) {
			await write(`setting:${key}`, value)
		},
	}
}
