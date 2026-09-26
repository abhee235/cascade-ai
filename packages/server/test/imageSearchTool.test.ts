// ADR-071 — ImageSearch: Openverse parsing + the CDN allowlist that mirrors the preview CSP img-src.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createImageSearchTool, IMAGE_CDN_ALLOWLIST, parseOpenverse, queryLadder } from '../src/imageSearchTool'

afterEach(() => vi.unstubAllGlobals())

const ctx = { cwd: '/tmp', abortSignal: new AbortController().signal } as never

describe('ImageSearch (Openverse)', () => {
  it('keeps only results on allowlisted CDNs, with credit', () => {
    const out = parseOpenverse({
      results: [
        { url: 'https://live.staticflickr.com/1/a.jpg', title: 'Watch', creator: 'Jo', license: 'by' },
        { url: 'https://evil.example.com/x.jpg', title: 'Bad' }, // off-allowlist → dropped
      ],
    })
    expect(out).toHaveLength(1)
    expect(out[0].url).toContain('staticflickr.com')
    expect(out[0].credit).toBe('Watch by Jo (BY)')
  })

  it('every allowlisted host is a bare hostname (so it maps cleanly into CSP img-src)', () => {
    for (const host of IMAGE_CDN_ALLOWLIST) expect(host).toMatch(/^[a-z0-9.-]+$/)
  })

  it('returns URLs the model can hotlink, pointing at the <Photo web> fallback path', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ results: [{ url: 'https://images.pexels.com/p/1.jpg', title: 'Shoe' }] }), { status: 200 })),
    )
    const r = await createImageSearchTool().call({ query: 'running shoe' }, ctx)
    expect(r.isError).toBeFalsy()
    expect(r.content).toContain('images.pexels.com')
    expect(r.content).toContain('<Photo web=') // steers to the fallback-safe block
  })

  it('says how to search when even the WIDENED query finds nothing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 })))
    const r = await createImageSearchTool().call({ query: 'nonexistent subject' }, ctx)
    expect(r.content).toContain('even after widening')
    expect(r.content).toContain('<ArtImage>') // no longer steers to webPhoto: its host answers 401 (2026-09-27)
  })

  it('WIDENS a natural-language query until it finds hits, and names the query that worked', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const q = new URL(url).searchParams.get('q')
      const results = q === 'coffee beans' ? [{ url: 'https://live.staticflickr.com/1/c.jpg', title: 'Beans' }] : []
      return new Response(JSON.stringify({ results }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const r = await createImageSearchTool().call({ query: 'coffee beans bag Ethiopia natural roast photography' }, ctx)
    expect(r.content).toContain('live.staticflickr.com')
    expect(r.content).toContain('this is "coffee beans"') // tells the model what shape actually works
    expect(fetchMock).toHaveBeenCalledTimes(4) // full → stopword-free → 3 words → 2 words
  })
})

// Measured 2026-09-27 against the live index: the long form returns 0 results, the short forms hundreds —
// "coffee beans bag Ethiopia natural roast photography" → 0, "Ethiopia coffee beans" → 47,
// "coffee beans" → 240, "cordless drill" → 224 (the original off-subject failure case).
describe('queryLadder — widen instead of returning nothing', () => {
  it('drops stopwords, then narrows to the 3 and 2 most salient words', () => {
    expect(queryLadder('coffee beans bag Ethiopia natural roast photography')).toEqual([
      'coffee beans bag Ethiopia natural roast photography',
      'coffee beans bag Ethiopia natural roast',
      'coffee beans bag',
      'coffee beans',
    ])
  })

  it('a query that is already short stays ONE rung — the common case costs one request', () => {
    expect(queryLadder('coffee beans')).toEqual(['coffee beans'])
    expect(queryLadder('cordless drill')).toHaveLength(1)
  })

  it('survives a query made entirely of stopwords without emitting empty rungs', () => {
    expect(queryLadder('a photo of the')).toEqual(['a photo of the'])
  })
})
