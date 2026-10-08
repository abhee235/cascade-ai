// ADR-091 §3 — keys typed into the desktop app persist through the host's OS-encrypted store; the server only
// sees the seam. Reported 2026-10-09: the OpenAI key had to be re-entered on every launch.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setProviderKey } from '../src/modelCaps'
import { applyStoredSecrets, installSecretStore, keyStorage, type SecretStore } from '../src/secretStore'

const SLOT = Symbol.for('cascade.secretStore')
let saved: string | undefined

function memoryStore(encrypted = true, initial: Record<string, string> = {}): SecretStore & { data: Record<string, string> } {
	const data = { ...initial }
	return {
		data,
		encrypted,
		load: () => ({ ...data }),
		set(name, value) {
			if (value === undefined) delete data[name]
			else if (!encrypted) return { persisted: false }
			else data[name] = value
			return { persisted: true }
		},
	}
}

beforeEach(() => {
	saved = process.env.OPENAI_API_KEY
	delete process.env.OPENAI_API_KEY
})
afterEach(() => {
	delete (globalThis as Record<symbol, unknown>)[SLOT]
	if (saved === undefined) delete process.env.OPENAI_API_KEY
	else process.env.OPENAI_API_KEY = saved
})

describe('secretStore seam', () => {
	it('no store installed: session-only, exactly as before (web/dev server)', () => {
		expect(keyStorage()).toBe('session')
		expect(applyStoredSecrets()).toBe(0)
		expect(setProviderKey('openai', 'sk-session')).toBe(true)
		expect(process.env.OPENAI_API_KEY).toBe('sk-session')
	})
	it('a typed key is stored, and cleared when the user clears it', () => {
		const store = memoryStore()
		installSecretStore(store)
		expect(keyStorage()).toBe('encrypted')
		setProviderKey('openai', '  sk-typed  ')
		expect(store.data.OPENAI_API_KEY).toBe('sk-typed')
		setProviderKey('openai', '')
		expect(store.data.OPENAI_API_KEY).toBeUndefined()
		expect(process.env.OPENAI_API_KEY).toBeUndefined()
	})
	it('on startup a stored key fills an unset env — and never overrides .env / the environment', () => {
		installSecretStore(memoryStore(true, { OPENAI_API_KEY: 'sk-stored' }))
		expect(applyStoredSecrets()).toBe(1)
		expect(process.env.OPENAI_API_KEY).toBe('sk-stored')
		process.env.OPENAI_API_KEY = 'sk-from-env'
		expect(applyStoredSecrets()).toBe(0)
		expect(process.env.OPENAI_API_KEY).toBe('sk-from-env')
	})
	it('no OS keyring: the UI is told "unavailable" and nothing is written', () => {
		const store = memoryStore(false)
		installSecretStore(store)
		expect(keyStorage()).toBe('unavailable')
		setProviderKey('openai', 'sk-x')
		expect(store.data).toEqual({})
		expect(process.env.OPENAI_API_KEY).toBe('sk-x') // still works for this session
	})
	it('a store that throws never breaks startup or setting a key', () => {
		installSecretStore({ encrypted: true, load: () => { throw new Error('locked') }, set: () => { throw new Error('locked') } })
		expect(applyStoredSecrets()).toBe(0)
		expect(setProviderKey('openai', 'sk-y')).toBe(true)
	})
})
