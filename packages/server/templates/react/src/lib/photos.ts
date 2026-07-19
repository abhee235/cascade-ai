// Bundled photo pack (see assets/photos/CREDITS.txt). Use for hero/lifestyle/real-world imagery;
// use <ArtImage> for products/avatars/abstract when no photo fits the subject. NEVER an emoji as an
// image, never an empty gray box.

const files = import.meta.glob('../assets/photos/*.webp', { eager: true, query: '?url', import: 'default' }) as Record<string, string>

const byName = Object.fromEntries(Object.entries(files).map(([path, url]) => [path.replace(/^.*\/(.+)\.webp$/, '$1'), url]))

export type PhotoName =
	| 'food-bowl'
	| 'food-salad'
	| 'product-watch'
	| 'product-shoe'
	| 'workspace-code'
	| 'workspace-office'
	| 'nature-mountain'
	| 'nature-beach'
	| 'interior-living'
	| 'architecture-city'
	| 'people-friends'
	| 'people-portrait'
	| 'texture-gradient'
	| 'texture-abstract'

export type PhotoCategory = 'food' | 'product' | 'workspace' | 'nature' | 'interior' | 'people' | 'texture'

const CATEGORIES: Record<PhotoCategory, PhotoName[]> = {
	food: ['food-bowl', 'food-salad'],
	product: ['product-watch', 'product-shoe'],
	workspace: ['workspace-code', 'workspace-office'],
	nature: ['nature-mountain', 'nature-beach'],
	interior: ['interior-living', 'architecture-city'],
	people: ['people-friends', 'people-portrait'],
	texture: ['texture-gradient', 'texture-abstract'],
}

/** URL for a specific bundled photo, e.g. `<img src={photo('nature-mountain')} alt="…" />`. */
export function photo(name: PhotoName): string {
	return byName[name] ?? ''
}

/** Deterministic photo pick within a category: same seed ⇒ same photo (stable across renders/builds). */
export function photoFor(seed: string, category: PhotoCategory = 'texture'): string {
	let h = 0x811c9dc5
	for (let i = 0; i < seed.length; i++) {
		h ^= seed.charCodeAt(i)
		h = Math.imul(h, 0x01000193)
	}
	const pool = CATEGORIES[category]
	return photo(pool[(h >>> 0) % pool.length])
}
