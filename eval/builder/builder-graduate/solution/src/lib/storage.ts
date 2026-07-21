// GRADUATED seam: the Entity/Store interfaces stay here (storage.api imports them); the createStore
// factory now comes from the API-backed store, so every view/hook keeps working against a real backend.

export interface Entity {
	id: string | number
}

export interface Store<T extends Entity> {
	list(): T[]
	get(id: T['id']): T | undefined
	create(item: T): T
	update(id: T['id'], patch: Partial<T>): T | undefined
	remove(id: T['id']): boolean
	replaceAll(items: T[]): void
}

export { createApiStore as createStore } from './storage.api'
