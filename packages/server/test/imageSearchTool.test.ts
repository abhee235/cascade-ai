// ADR-071 — ImageSearch: Openverse parsing + the CDN allowlist that mirrors the preview CSP img-src.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createImageSearchTool, IMAGE_CDN_ALLOWLIST, parseOpenverse } from '../src/imageSearchTool'

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

  it('degrades to a webPhoto suggestion when Openverse has nothing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 })))
    const r = await createImageSearchTool().call({ query: 'nonexistent subject' }, ctx)
    expect(r.content).toContain('webPhoto(')
  })
})
