// lib/storage.api.ts — the API-backed half of the persistence seam (added by the backend pack).
//
// SAME interface as src/lib/storage.ts (createStore) so graduating a prototype is a ONE-LINE change:
// in src/lib/storage.ts, re-export from here instead of the localStorage factory —
//     export { createApiStore as createStore } from './storage.api'
// and every view/hook keeps working, now talking to the API.
//
// Offline-first: reads hit /api/<key> but fall back to a localStorage cache when the server is down (so
// the app still renders during a cold backend start); writes go to the API and refresh the cache. This is
// the pattern the app used as a prototype, now backed by a real database.
//
// NOTE: the store interface is synchronous (list() returns T[]) to keep views unchanged. So this keeps a
// local cache as the synchronous source of truth and syncs it with the server in the background. Call
// `store.refresh()` on mount (e.g. in a hook's useEffect) to pull the latest from the API.

import type { Entity, Store } from './storage'

export interface ApiStore<T extends Entity> extends Store<T> {
	/** Pull the latest from the API into the cache; returns the fresh list. Call on mount. */
	refresh(): Promise<T[]>
}

export function createApiStore<T extends Entity>(key: string, seed: T[] = []): ApiStore<T> {
	const base = `/api/${key}`
	const cacheKey = `app:cache:${key}`

	const readCache = (): T[] => {
		try {
			const raw = localStorage.getItem(cacheKey)
			if (raw) return JSON.parse(raw) as T[]
		} catch {
			/* ignore */
		}
		return [...seed]
	}
	const writeCache = (items: T[]): void => {
		try {
			localStorage.setItem(cacheKey, JSON.stringify(items))
		} catch {
			/* ignore */
		}
	}

	return {
		list: () => readCache(),
		get: (id) => readCache().find((e) => e.id === id),
		create(item) {
			const items = readCache()
			items.push(item)
			writeCache(items) // optimistic
			void fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(item) })
				.then((r) => (r.ok ? r.json() : null))
				.then((saved) => {
					if (saved) writeCache(readCache().map((e) => (e.id === item.id ? (saved as T) : e)))
				})
				.catch(() => {}) // offline: the optimistic cache stands until next refresh
			return item
		},
		update(id, patch) {
			const items = readCache()
			const i = items.findIndex((e) => e.id === id)
			if (i < 0) return undefined
			items[i] = { ...items[i], ...patch, id: items[i].id }
			writeCache(items)
			void fetch(`${base}/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }).catch(() => {})
			return items[i]
		},
		remove(id) {
			const items = readCache()
			const next = items.filter((e) => e.id !== id)
			if (next.length === items.length) return false
			writeCache(next)
			void fetch(`${base}/${id}`, { method: 'DELETE' }).catch(() => {})
			return true
		},
		replaceAll(items) {
			writeCache(items)
		},
		async refresh() {
			try {
				const res = await fetch(base)
				if (res.ok) {
					const fresh = (await res.json()) as T[]
					writeCache(fresh)
					return fresh
				}
			} catch {
				/* offline — keep the cache */
			}
			return readCache()
		},
	}
}
