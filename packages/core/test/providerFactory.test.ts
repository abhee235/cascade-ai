// providerFactory.test.ts — createProvider() routing + API-key resolution (multi-provider).
// The factory is pure config→object wiring, so tests assert through OBSERVABLE behavior: which URL a
// completion hits and which Authorization header it carries (via a stubbed fetch), never private fields.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProvider } from '../src/llm/factory'

/** Stub fetch, run one complete(), and return the {url, headers} the provider actually sent. */
async function captureRequest(provider: ReturnType<typeof createProvider>) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] })))
  vi.stubGlobal('fetch', fetchMock)
  await provider.complete({ messages: [{ role: 'user', content: 'hi' }], model: 'm' })
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
  return { url, headers: init.headers as Record<string, string> }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('createProvider routing', () => {
  it('nvidia maps to the NIM origin with Bearer auth from NVIDIA_API_KEY', async () => {
    vi.stubEnv('NVIDIA_API_KEY', 'nvapi-test')
    const { url, headers } = await captureRequest(createProvider({ provider: 'nvidia', model: 'm' }))
    expect(url).toBe('https://integrate.api.nvidia.com/v1/chat/completions')
    expect(headers.Authorization).toBe('Bearer nvapi-test')
  })

  it('an UNKNOWN id works when baseUrl is given (the generic api-based provider)', async () => {
    const { url } = await captureRequest(createProvider({ provider: 'fireworks', model: 'm', baseUrl: 'https://api.fireworks.ai/inference' }))
    expect(url).toBe('https://api.fireworks.ai/inference/v1/chat/completions')
  })

  it('an unknown id WITHOUT baseUrl throws with the known-provider list', () => {
    expect(() => createProvider({ provider: 'nope', model: 'm' })).toThrow(/Unknown provider "nope".*baseUrl/s)
  })

  it('key resolution: explicit config beats the provider env var', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-env')
    const { headers } = await captureRequest(createProvider({ provider: 'openai', model: 'm', apiKey: 'sk-explicit' }))
    expect(headers.Authorization).toBe('Bearer sk-explicit')
  })

  it('key resolution: provider env var beats the generic CASCADE_API_KEY', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-openai')
    vi.stubEnv('CASCADE_API_KEY', 'generic')
    const { headers } = await captureRequest(createProvider({ provider: 'openai', model: 'm' }))
    expect(headers.Authorization).toBe('Bearer sk-openai')
  })

  it('key resolution: CASCADE_API_KEY covers custom endpoints with no conventional var', async () => {
    vi.stubEnv('CASCADE_API_KEY', 'generic')
    const { headers } = await captureRequest(createProvider({ provider: 'myproxy', model: 'm', baseUrl: 'http://10.0.0.5:8000' }))
    expect(headers.Authorization).toBe('Bearer generic')
  })

  it('local ollama sends NO Authorization header when no key is set', async () => {
    const { url, headers } = await captureRequest(createProvider({ provider: 'ollama', model: 'm' }))
    expect(url).toBe('http://127.0.0.1:11434/v1/chat/completions')
    expect(headers.Authorization).toBeUndefined()
  })
})
