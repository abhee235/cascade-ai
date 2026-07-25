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

// ── Real WEB photos (opt-in) ──────────────────────────────────────────────────────────────────────
// The bundled pack + <ArtImage> are the ROBUST default (offline, deterministic, on-theme). But some
// apps genuinely need real, subject-accurate photography that the small pack can't cover — an e-commerce
// catalog of real products, a travel/real-estate/recipe listing. For those, pull from an ALLOWLIST of
// keyless, hotlink-safe sources ONLY — never arbitrary URLs (security: two known hosts, nothing else):
//   • loremflickr.com  — keyword-relevant, CC-licensed Flickr photos (best for products)
//   • picsum.photos    — seeded realistic stock (subject is random)
// Prefer the <Photo> block over these raw URLs: it renders the photo with an automatic <ArtImage>
// fallback, so a blocked/slow/failed load is NEVER a broken box.

const seedNum = (s: string | number): number => {
	if (typeof s === 'number') return Math.abs(Math.trunc(s)) % 100000
	let h = 0x811c9dc5
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i)
		h = Math.imul(h, 0x01000193)
	}
	return (h >>> 0) % 100000
}

/** A REAL, subject-relevant photo from loremflickr (allowlisted, keyless). Deterministic per seed —
 *  `webPhoto('leather watch minimal', product.name)`. Use when generated ArtImage looks too abstract
 *  for the subject (real products, real-world listings). Space-separated keywords narrow the subject. */
export function webPhoto(keywords: string, seed: string | number, size = 600): string {
	// loremflickr AND-matches comma keywords; 3+ tags usually match NOTHING and it serves a generic
	// placeholder at HTTP 200 (so <Photo>'s onError fallback never fires — you get a wrong photo, not
	// ArtImage). Keep the 2 most salient words so the query actually resolves to a real, on-subject photo.
	const kw = keywords.trim().split(/\s+/).slice(0, 2).join(',')
	// The deterministic pin MUST be the `?lock=` QUERY param. A trailing `/<n>` path segment (the old form)
	// now 404s on loremflickr — which silently dropped EVERY web photo to the ArtImage fallback.
	return `https://loremflickr.com/${size}/${size}/${encodeURIComponent(kw)}?lock=${seedNum(seed)}`
}

/** A seeded realistic stock photo (random subject) from picsum.photos (allowlisted, keyless). For
 *  heroes/banners/covers where you want a real photo but the exact subject doesn't matter. */
export function seedPhoto(seed: string | number, w = 1200, h = 600): string {
	return `https://picsum.photos/seed/${encodeURIComponent(String(seed))}/${w}/${h}`
}
