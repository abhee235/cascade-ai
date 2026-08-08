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

import type { ConfigStore, ConnectorRecord, ModelRecord } from '@cascade/storage'
import type { Db } from './db.js'
import { kyselyFor } from './kysely.js'

type ActiveModel = { provider: string; model: string; baseUrl?: string }

const MODELS = 'models'
const ACTIVE = 'activeModel'
const CONNECTORS = 'connectors'

export function createConfigStore(db: Db): ConfigStore {
	const k = kyselyFor(db)

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

	// Serialize every DOCUMENT mutation. upsert/remove are read-modify-write of one JSON value, so two
	// concurrent calls both read the same snapshot and the second write silently erases the first's change.
	// Not hypothetical: seeding three defaults at boot persisted two of them (caught by test), and a bulk
	// delete raced the same way. Callers are fire-and-forget by design, so the fix cannot be "make callers
	// await" — the store itself must queue. Reads stay unserialized; they cannot lose anything.
	let chain: Promise<unknown> = Promise.resolve()
	const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
		const next = chain.then(fn, fn)
		chain = next.catch(() => {}) // one failed write must not wedge the queue forever
		return next
	}

	return {
		async models() {
			return models()
		},
		upsertModel(m) {
			return serialize(async () => {
			const list = await models()
			const i = list.findIndex((x) => sameModel(x, m.provider, m.model))
			// MERGE, never replace: the editor sends only the fields it changed, and a naive overwrite would
			// silently drop the endpoint's stored key when someone edits the context window.
			if (i >= 0) list[i] = { ...list[i], ...m, apiKey: m.apiKey ?? list[i].apiKey }
			else list.push(m)
			await write(MODELS, list)
			})
		},
		removeModel(provider, model) {
			return serialize(async () =>
				write(
					MODELS,
					(await models()).filter((m) => !sameModel(m, provider, model)),
				),
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
		upsertConnector(c) {
			return serialize(async () => {
			const list = await connectors()
			const i = list.findIndex((x) => x.name === c.name)
			// The documented merge rule (ADR-071): `apiKey` UNDEFINED keeps the stored key — that is what makes
			// "change the host without re-entering the key" work — '' clears it, a string replaces it.
			if (i >= 0) list[i] = { ...list[i], ...c, apiKey: c.apiKey === undefined ? list[i].apiKey : c.apiKey || undefined }
			else list.push(c)
			await write(CONNECTORS, list)
			})
		},
		removeConnector(name) {
			return serialize(async () =>
				write(
					CONNECTORS,
					(await connectors()).filter((c) => c.name !== name),
				),
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
