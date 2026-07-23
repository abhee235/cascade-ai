// ADR-071 — WebFetch: SSRF guard + HTML→markdown conversion. (Web SEARCH is via MCP, not a built-in tool.)
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertFetchableUrl, WebFetchTool } from '../src/tools/builtins/WebFetch'
import type { ToolContext } from '../src/tools/Tool'

const ctx = { cwd: '/tmp', abortSignal: new AbortController().signal } as ToolContext
afterEach(() => vi.unstubAllGlobals())

describe('WebFetch SSRF guard (assertFetchableUrl)', () => {
  it('accepts a normal public https URL', () => {
    expect(assertFetchableUrl('https://example.com/docs').hostname).toBe('example.com')
  })
  it.each([
    'http://localhost:5319/token', // the Cascade server itself
    'http://127.0.0.1/', // loopback
    'http://10.1.2.3/', // private
    'http://192.168.0.1/', // private
    'http://172.16.5.5/', // private
    'http://169.254.169.254/latest/meta-data/', // AWS metadata
    'http://metadata.google.internal/', // GCP metadata
    'http://[::1]/', // IPv6 loopback
    'http://something.local/', // mDNS
    'ftp://example.com/', // wrong protocol
    'file:///etc/passwd', // wrong protocol
  ])('refuses %s', (url) => {
    expect(() => assertFetchableUrl(url)).toThrow()
  })

  it('re-checks a redirect that points at localhost (open-redirect SSRF)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 302, headers: { location: 'http://127.0.0.1:5319/token' } })),
    )
    const r = await WebFetchTool.call({ url: 'https://example.com/redirect' }, ctx)
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/private\/loopback\/metadata/)
  })

  it('converts HTML to markdown (headings, links) and drops boilerplate', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html><head><style>x{}</style></head><body><nav>menu junk</nav><h2>Docs</h2><script>evil()</script><p>See <a href="https://react.dev">React</a> &amp; more.</p></body></html>', { status: 200, headers: { 'content-type': 'text/html' } })),
    )
    const r = await WebFetchTool.call({ url: 'https://example.com' }, ctx)
    expect(r.isError).toBeFalsy()
    expect(r.content).toContain('## Docs') // heading → markdown
    expect(r.content).toContain('[React](https://react.dev)') // link preserved as markdown
    expect(r.content).toContain('&') // entity decoded
    expect(r.content).not.toContain('evil') // script dropped
    expect(r.content).not.toContain('menu junk') // nav boilerplate dropped
    expect(r.content).not.toContain('<') // no raw tags
  })

  it('returns already-markdown content untouched (content negotiation)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('# Hello\n\nAlready markdown.', { status: 200, headers: { 'content-type': 'text/markdown' } })))
    const r = await WebFetchTool.call({ url: 'https://docs.example.com/x.md' }, ctx)
    expect(r.content).toContain('# Hello')
    expect(r.content).toContain('Already markdown.')
  })
})
