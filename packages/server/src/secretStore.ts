// secretStore.ts — where API keys typed into the app are kept between runs (ADR-091 §3).
//
// The server stays host-agnostic: it never imports Electron. A HOST that can encrypt with the OS (the desktop
// shell, via safeStorage: DPAPI / Keychain / libsecret) installs a store on globalThis before loading the server.
// No store installed (the web/dev server) ⇒ keys stay session-only, exactly as before; a developer keeps
// persistent keys in .env.

export interface SecretStore {
	/** True when the OS can encrypt (DPAPI / Keychain / a Linux keyring). False ⇒ set() refuses to write. */
	readonly encrypted: boolean
	/** Every stored secret, decrypted: env-var name → value. */
	load(): Record<string, string>
	/** Store (value) or delete (undefined). `persisted: false` = it could not be stored safely (no OS keyring). */
	set(name: string, value: string | undefined): { persisted: boolean }
}

const SLOT = Symbol.for('cascade.secretStore')

export function installSecretStore(store: SecretStore): void {
	;(globalThis as Record<symbol, unknown>)[SLOT] = store
}

export function secretStore(): SecretStore | undefined {
	return (globalThis as Record<symbol, unknown>)[SLOT] as SecretStore | undefined
}

/** What the UI may promise about a key the user types: kept encrypted, impossible to keep, or session-only. */
export function keyStorage(): 'encrypted' | 'unavailable' | 'session' {
	const store = secretStore()
	return !store ? 'session' : store.encrypted ? 'encrypted' : 'unavailable'
}

/** At startup: stored keys fill process.env ONLY where nothing set one — an explicit environment or .env wins. */
export function applyStoredSecrets(): number {
	const store = secretStore()
	if (!store) return 0
	let applied = 0
	try {
		for (const [name, value] of Object.entries(store.load())) {
			if (process.env[name] || !value) continue
			process.env[name] = value
			applied++
		}
	} catch {
		/* an unreadable store must never stop the server — the user re-enters the key */
	}
	return applied
}
