// lib/storage.ts — THE PERSISTENCE SEAM, graduated (round 2). The localStorage factory is gone: the seam
// now re-exports the API-backed store (backend pack), which keeps the same interface — the one-line
// graduation the seam exists for. Views built in the prototype round kept working unchanged; later rounds
// moved list views to the typed API client (src/lib/api.ts) as the server grew query params the generic
// store interface can't express (search/filter/pagination envelopes).

export interface Entity {
	id: string | number
}

export interface Store<T extends Entity> {
	/** All entities (a fresh array — mutate freely, then write back via create/update/remove). */
	list(): T[]
	get(id: T['id']): T | undefined
	create(item: T): T
	update(id: T['id'], patch: Partial<T>): T | undefined
	remove(id: T['id']): boolean
	/** Replace the whole collection (imports, bulk resets). */
	replaceAll(items: T[]): void
}

export { createApiStore as createStore } from './storage.api'
