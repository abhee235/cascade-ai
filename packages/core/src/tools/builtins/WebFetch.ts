// tools/builtins/WebFetch.ts — fetch one URL and return its content as markdown. Read-only.
// ADR-071. Algorithm:
//   1. plain HTTP GET (no headless browser — JS is not rendered; a browser fallback is a later opt-in)
//   2. content-negotiate markdown first, else convert HTML → markdown, preserving structure
//   3. manual redirects, each hop re-checked by the SSRF guard (stronger than a single-label check)
// Deferred (needs ToolContext to carry a model): a summarize-on-fetch pass so the main model reads a DIGEST,
// not the whole page — the single biggest small-window win (a small, fast model can write the digest).
//
// SECURITY: a fetch tool the model drives is an SSRF vector — a stray URL (or prompt injection) could aim
// it at localhost, a LAN service, or a cloud metadata endpoint. `assertFetchableUrl` blocks the obvious
// targets (loopback / private / link-local / ULA / metadata) and every redirect hop is re-checked. A
// DNS-rebinding-proof guard (resolve then pin the IP) is deliberately out of scope for v1 (see ADR-071).

import { z } from 'zod'
import type { Tool } from '../Tool'

const inputSchema = z.object({
  url: z.string().describe('The absolute http(s) URL to fetch.'),
})

const MAX_REDIRECTS = 5
const TIMEOUT_MS = 15_000
const DEFAULT_CAP = 50_000 // chars of extracted text (ctx.readCapChars overrides — one bite ≤ the plate, ADR-052)

/** Private / loopback / link-local / ULA IPv4+IPv6 literals and the cloud-metadata endpoints. */
function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '') // strip IPv6 brackets
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true
  if (h === 'metadata.google.internal') return true
  // IPv4 literal
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])]
    if (a === 0 || a === 127 || a === 10) return true // this-host, loopback, private
    if (a === 169 && b === 254) return true // link-local incl. 169.254.169.254 metadata
    if (a === 172 && b >= 16 && b <= 31) return true // private
    if (a === 192 && b === 168) return true // private
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
    return false
  }
  // IPv6 literal
  if (h === '::1' || h === '::') return true // loopback / unspecified
  if (h.startsWith('fc') || h.startsWith('fd')) return true // unique-local
  if (h.startsWith('fe80')) return true // link-local
  if (h.startsWith('::ffff:')) return isBlockedHost(h.slice(7)) // IPv4-mapped
  return false
}

/** Throws with a model-readable reason if `url` is not a safe public http(s) target. Exported for tests. */
export function assertFetchableUrl(url: string): URL {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new Error(`Not a valid URL: ${url}`)
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`Only http(s) URLs can be fetched (got ${u.protocol}).`)
  if (isBlockedHost(u.hostname)) throw new Error(`Refusing to fetch a private/loopback/metadata address (${u.hostname}).`)
  return u
}

const decodeEntities = (s: string): string =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))

/** HTML → MARKDOWN. Convert rather than flatten, because structure — headings, links, list items, code —
 *  is exactly what a model needs to navigate a page; a flat wall of words loses it. This keeps that structure
 *  without a dependency (core is bundled into the extension, so a dep-free converter is worth the regex).
 *  Boilerplate (nav/header/footer/aside/script/style) is dropped first so the model reads content, not chrome. */
function htmlToMarkdown(html: string): string {
  let s = html
    .replace(/<(script|style|noscript|template|svg|nav|header|footer|aside|form)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
  // links first (before tags are stripped): <a href="X">text</a> → [text](X)
  s = s.replace(/<a\b[^>]*?href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
    const t = decodeEntities(text.replace(/<[^>]+>/g, '').trim())
    return t ? `[${t}](${href})` : ''
  })
  s = s
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, t) => `\n\n${'#'.repeat(Number(n))} ${t.replace(/<[^>]+>/g, '').trim()}\n`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, t) => `\n- ${t.replace(/<[^>]+>/g, ' ').trim()}`)
    .replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, (_, __, t) => `**${t.replace(/<[^>]+>/g, '').trim()}**`)
    .replace(/<(em|i)>([\s\S]*?)<\/\1>/gi, (_, __, t) => `*${t.replace(/<[^>]+>/g, '').trim()}*`)
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, t) => `\n\`\`\`\n${decodeEntities(t.replace(/<[^>]+>/g, ''))}\n\`\`\`\n`)
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, t) => `\`${decodeEntities(t.replace(/<[^>]+>/g, ''))}\``)
    .replace(/<\/(p|div|section|article|tr|h[1-6]|ul|ol|table)>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '') // remaining tags
  return decodeEntities(s)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export const WebFetchTool: Tool<z.infer<typeof inputSchema>> = {
  name: 'WebFetch',
  description: `Fetch a single web page and return its text content (HTML stripped). Use it to READ a page whose URL you already know — docs, a reference, an article you found via WebSearch. For arbitrary queries, use WebSearch first to get URLs, then WebFetch one. http(s) only; private/loopback/metadata addresses are refused.`,
  inputSchema,
  activitySummary: (input) => `Fetching ${input.url}`,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(input, ctx) {
    let url: URL
    try {
      url = assertFetchableUrl(input.url)
    } catch (e) {
      return { content: (e as Error).message, isError: true }
    }
    // Follow redirects MANUALLY so each hop is re-validated — an open-redirect to localhost is a classic
    // SSRF bypass. Node's fetch would otherwise chase them for us, unchecked.
    const timeout = AbortSignal.timeout(TIMEOUT_MS)
    const signal = ctx.abortSignal ? AbortSignal.any([ctx.abortSignal, timeout]) : timeout
    let current = url
    try {
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        // Content-negotiate markdown FIRST (Qwen's trick): docs sites increasingly serve text/markdown, which
        // is already the ideal shape — no conversion, no boilerplate. HTML is the fallback we convert.
        const res = await fetch(current, { redirect: 'manual', signal, headers: { 'user-agent': 'CascadeBot/1.0', accept: 'text/markdown, text/html;q=0.9, text/plain;q=0.8, */*;q=0.1' } })
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get('location')
          if (!loc) return { content: `Redirect with no Location header (HTTP ${res.status}).`, isError: true }
          current = assertFetchableUrl(new URL(loc, current).href) // re-check the hop
          continue
        }
        if (!res.ok) return { content: `HTTP ${res.status} ${res.statusText} for ${current.href}`, isError: true }
        const ctype = res.headers.get('content-type') ?? ''
        const raw = await res.text()
        const text = ctype.includes('markdown') ? raw.trim() : ctype.includes('html') ? htmlToMarkdown(raw) : raw.trim()
        const cap = ctx.readCapChars ?? DEFAULT_CAP
        const clipped = text.length > cap ? `${text.slice(0, cap)}\n…(truncated, ${text.length - cap} more chars)` : text
        return { content: `URL: ${current.href}\n\n${clipped || '(no readable text)'}` }
      }
      return { content: `Too many redirects (>${MAX_REDIRECTS}).`, isError: true }
    } catch (e) {
      const msg = (e as Error)?.name === 'TimeoutError' ? `Timed out after ${TIMEOUT_MS / 1000}s` : (e as Error).message
      return { content: `Fetch failed: ${msg}`, isError: true }
    }
  },
}
