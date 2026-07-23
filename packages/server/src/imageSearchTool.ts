// imageSearchTool.ts — find real, subject-accurate stock images the model bakes into the app it's building.
// Server-side (not core): app-building-specific, and coupled to the preview CSP `img-src` + host allowlist,
// both of which live here. Injected per-session via `extraTools`, like the Browser tool. ADR-071.
//
// Backend: Openverse (api.openverse.org) — keyless, CC-licensed, keyword search returning real photo URLs
// on known CDNs. Optional Pexels/Unsplash if a key is set (higher quality). The model gets URLs only; it
// drops them into <Photo web="…"> / <img>. This is the CAPABLE-model / curation path — for a catalog of
// many items a weak model still wins with the runtime webPhoto() helper (one call, no multi-step).
//
// SECURITY: results are on a small set of KNOWN CDNs (the allowlist below). Whatever hosts appear here must
// also be in the preview's CSP img-src, or the sandbox blocks the images (broken boxes).

import { z } from 'zod'
import type { Tool } from '@cascade/core'

const inputSchema = z.object({
  query: z.string().describe('What the image should show, e.g. "leather watch on wood" or "hiking backpack outdoor". Be specific — concrete nouns beat abstractions.'),
  count: z.number().int().min(1).max(10).optional().describe('How many image URLs to return (default 4).'),
})

/** CDN hosts Openverse/Pexels/Unsplash actually serve from — mirror this in the preview CSP img-src. */
export const IMAGE_CDN_ALLOWLIST = [
  'live.staticflickr.com',
  'upload.wikimedia.org',
  'images.pexels.com',
  'images.unsplash.com',
]

interface OpenverseHit {
  url?: string
  title?: string
  creator?: string
  license?: string
  foreign_landing_url?: string
}

/** Parse Openverse's `GET /v1/images/` JSON into {url, credit}. Exported for tests. */
export function parseOpenverse(json: unknown): { url: string; credit: string }[] {
  const results = (json as { results?: OpenverseHit[] })?.results ?? []
  return results
    .filter((h): h is OpenverseHit & { url: string } => typeof h.url === 'string' && IMAGE_CDN_ALLOWLIST.some((host) => h.url!.includes(host)))
    .map((h) => ({ url: h.url, credit: `${h.title ?? 'photo'}${h.creator ? ` by ${h.creator}` : ''}${h.license ? ` (${h.license.toUpperCase()})` : ''}` }))
}

export function createImageSearchTool(): Tool<z.infer<typeof inputSchema>> {
  return {
    name: 'ImageSearch',
    description: `Find REAL stock photos for the app you're building — a product catalog, a hero image, a listing. Returns image URLs (already on allowlisted CDNs) you drop into <Photo web="…"> or <img src>. Use it when a subject needs a real photograph the bundled pack can't cover. For MANY similar items (a 12-product grid), prefer the runtime helper webPhoto('keywords', seed) — one line, no per-image call.`,
    inputSchema,
    activitySummary: (input) => `Finding images: ${input.query}`,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async call(input, ctx) {
      const q = input.query.trim()
      if (!q) return { content: 'Empty query.', isError: true }
      const n = input.count ?? 4
      const timeout = AbortSignal.timeout(15_000)
      const signal = ctx.abortSignal ? AbortSignal.any([ctx.abortSignal, timeout]) : timeout
      try {
        const res = await fetch(`https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&page_size=${Math.min(n * 3, 20)}&license_type=commercial&mature=false`, {
          signal,
          headers: { accept: 'application/json', 'user-agent': 'CascadeBot/1.0' },
        })
        if (!res.ok) return { content: `Image search unavailable (Openverse HTTP ${res.status}). Fall back to webPhoto('${q}', seed) or an <ArtImage>.`, isError: true }
        const hits = parseOpenverse(await res.json()).slice(0, n)
        if (!hits.length) return { content: `No stock photos for "${q}". Use webPhoto('${q}', seed) for a keyword photo, or <ArtImage> for an on-theme generated one.` }
        const body = hits.map((h, i) => `${i + 1}. ${h.url}\n   ${h.credit}`).join('\n')
        return { content: `Images for "${q}" (CC-licensed, allowlisted CDN — safe to hotlink):\n${body}\n\nUse in <Photo web="URL"> so a slow/failed load falls back to <ArtImage>.` }
      } catch (e) {
        const msg = (e as Error)?.name === 'TimeoutError' ? 'timed out' : (e as Error).message
        return { content: `Image search failed: ${msg}. Use webPhoto('${q}', seed) instead.`, isError: true }
      }
    },
  }
}
