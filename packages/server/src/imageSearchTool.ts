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

/** Words that carry no search signal and only tighten Openverse's AND. */
const STOPWORDS = new Set(['a', 'an', 'the', 'of', 'in', 'on', 'at', 'with', 'and', 'for', 'photo', 'photos', 'photography', 'photograph', 'image', 'images', 'picture', 'pictures', 'shot', 'closeup', 'close-up', 'background', 'realistic', 'professional'])

/**
 * Progressively WIDENED queries — full, then stopword-free, then the 3 and 2 most salient words.
 *
 * Openverse AND-matches every term, so a natural-language query matches nothing at all. Measured
 * 2026-09-27: `coffee beans bag Ethiopia natural roast photography` → **0** results, `Ethiopia coffee
 * beans` → 47, `coffee beans` → 240 — and the original off-subject failure case, `cordless drill`, → 224.
 * Models write the long form: 12 of 12 searches across two live builds came back empty, after which the
 * model gave up on the tool and hand-wrote image URLs instead. The tool was never broken; it just took the
 * model's phrasing literally. The same lesson `webPhoto` already encodes for its own AND-matching host.
 */
export function queryLadder(query: string): string[] {
  const words = query.trim().split(/\s+/).filter(Boolean)
  const salient = words.filter((w) => !STOPWORDS.has(w.toLowerCase()))
  const rungs = [words.join(' '), salient.join(' '), salient.slice(0, 3).join(' '), salient.slice(0, 2).join(' ')]
  return [...new Set(rungs.filter((r) => r.length > 0))] // dedup keeps a short query to a single request
}

export function createImageSearchTool(): Tool<z.infer<typeof inputSchema>> {
  return {
    name: 'ImageSearch',
    description: `Find REAL stock photos for the app you're building — a product catalog, a hero image, a listing. Returns image URLs (already on allowlisted CDNs) that you pass STRAIGHT to <Photo web="https://…" seed={…}> (it takes a URL as readily as keywords) or <img src>. SEARCH 2-3 CONCRETE NOUNS — "coffee beans", "cordless drill" — because the index AND-matches every word, so a long descriptive phrase ("coffee beans bag Ethiopia natural roast photography") matches NOTHING. Use it whenever a photo must match its label: a product catalog, a named-dish menu. The runtime helper webPhoto('keywords', seed) is only a guess AND its host is frequently unavailable, so it may render an unrelated photo — keep it for decorative imagery only. For a catalog, search once per product (or per category) and store the URLs on your data.`,
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
        // Walk the ladder: the first rung with usable hits wins. A query that is already short produces a
        // single rung, so the common case still costs exactly one request.
        for (const rung of queryLadder(q)) {
          const res = await fetch(`https://api.openverse.org/v1/images/?q=${encodeURIComponent(rung)}&page_size=${Math.min(n * 3, 20)}&license_type=commercial&mature=false`, {
            signal,
            headers: { accept: 'application/json', 'user-agent': 'CascadeBot/1.0' },
          })
          if (!res.ok) return { content: `Image search unavailable (Openverse HTTP ${res.status}). Use <ArtImage> for an on-theme generated image.`, isError: true }
          const hits = parseOpenverse(await res.json()).slice(0, n)
          if (!hits.length) continue
          const body = hits.map((h, i) => `${i + 1}. ${h.url}\n   ${h.credit}`).join('\n')
          // Name the widening when it happened, so the model learns the shape that actually works.
          const widened = rung === q ? '' : `\n(Nothing matched "${q}" — Openverse AND-matches every word, so this is "${rung}". Search 2-3 concrete nouns.)`
          return { content: `Images for "${rung}" (CC-licensed, allowlisted CDN — safe to hotlink):\n${body}${widened}\n\nPaste a URL STRAIGHT into <Photo web="https://…" seed={…}> — it renders a URL as-is and falls back to <ArtImage> if the load fails.` }
        }
        return { content: `No stock photos for "${q}", even after widening the search. Try 2 concrete nouns ("coffee beans", "cordless drill"), or use <ArtImage> for an on-theme generated image.` }
      } catch (e) {
        const msg = (e as Error)?.name === 'TimeoutError' ? 'timed out' : (e as Error).message
        return { content: `Image search failed: ${msg}. Use <ArtImage seed={…} kind="product" /> for an on-theme generated image.`, isError: true }
      }
    },
  }
}
