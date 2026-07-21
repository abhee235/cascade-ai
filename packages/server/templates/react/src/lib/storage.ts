// lib/storage.ts — THE PERSISTENCE SEAM. Every collection your app stores goes through createStore,
// never through raw localStorage in views or hooks. Why: this file is the ONLY thing that changes when
// the app graduates from a prototype (browser-local data) to a real backend (API + database) — the
// backend pack swaps the implementation behind the same interface, and every view keeps working.
//
// Usage (typical):
//   import { createStore } from '@/lib/storage'
//   import { SEED_RECIPES } from '@/lib/data'
//   const recipeStore = createStore<Recipe>('recipes', SEED_RECIPES)
//   // in a hook: const [recipes, setRecipes] = useState(() => recipeStore.list())
//   //            recipeStore.create(newRecipe); setRecipes(recipeStore.list())
//
// Rules:
//   - One store per collection, created once at module scope (not inside components).
//   - Entities need a stable `id` (string or number).
//   - Scalar preferences (theme, a flag) may still use a plain useLocalStorage hook — stores are for
//     COLLECTIONS of entities.

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

/** A localStorage-backed collection store, seeded on first run. The backend pack replaces this factory
 *  with an API-backed twin (same interface) — do not add methods here without updating the seam docs. */
export function createStore<T extends Entity>(key: string, seed: T[] = []): Store<T> {
	const storageKey = `app:${key}`

	const read = (): T[] => {
		try {
			const raw = localStorage.getItem(storageKey)
			if (raw) return JSON.parse(raw) as T[]
		} catch {
			/* corrupt/unavailable storage falls back to seed */
		}
		write(seed)
		return [...seed]
	}
	const write = (items: T[]): void => {
		try {
			localStorage.setItem(storageKey, JSON.stringify(items))
		} catch {
			/* quota/unavailable — the app keeps working in-memory for this session */
		}
	}

	return {
		list: () => read(),
		get: (id) => read().find((e) => e.id === id),
		create(item) {
			const items = read()
			items.push(item)
			write(items)
			return item
		},
		update(id, patch) {
			const items = read()
			const i = items.findIndex((e) => e.id === id)
			if (i < 0) return undefined
			items[i] = { ...items[i], ...patch, id: items[i].id }
			write(items)
			return items[i]
		},
		remove(id) {
			const items = read()
			const next = items.filter((e) => e.id !== id)
			if (next.length === items.length) return false
			write(next)
			return true
		},
		replaceAll(items) {
			write(items)
		},
	}
}
