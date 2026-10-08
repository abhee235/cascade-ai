// secrets.ts — the OS-encrypted store for API keys typed into the app (ADR-091 §3).
//
// Electron safeStorage encrypts with the OS user account: DPAPI on Windows, the Keychain on macOS, libsecret or
// KWallet on Linux. The ciphertext lives in <userData>/secrets.json as base64 — copying the file to another
// account or machine yields nothing readable. Installed on globalThis for the server's secretStore seam, by the
// same Symbol.for key, so the desktop does not bundle a second copy of server code.

import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SecretStore } from '../../server/src/secretStore'

const file = () => join(app.getPath('userData'), 'secrets.json')

/** Real encryption only. On Linux with no keyring Chromium falls back to `basic_text`: a hard-coded key, which is
 *  obfuscation — a key is then NOT written, and the UI says it cannot be saved. */
function canEncrypt(): boolean {
	try {
		if (!safeStorage.isEncryptionAvailable()) return false
		if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') return false
		return true
	} catch {
		return false
	}
}

function readEntries(): Record<string, string> {
	try {
		if (!existsSync(file())) return {}
		const parsed = JSON.parse(readFileSync(file(), 'utf8')) as { entries?: Record<string, string> }
		return parsed.entries ?? {}
	} catch {
		return {} // corrupt or unreadable: start empty rather than refuse to boot
	}
}

function writeEntries(entries: Record<string, string>): void {
	const tmp = `${file()}.tmp`
	writeFileSync(tmp, JSON.stringify({ version: 1, entries }, null, 2), { mode: 0o600 })
	renameSync(tmp, file()) // atomic replace: a crash mid-write never leaves half a file
}

export function createSecretStore(): SecretStore {
	return {
		get encrypted() {
			return canEncrypt()
		},
		load() {
			if (!canEncrypt()) return {}
			const out: Record<string, string> = {}
			for (const [name, b64] of Object.entries(readEntries())) {
				try {
					out[name] = safeStorage.decryptString(Buffer.from(b64, 'base64'))
				} catch {
					/* written under another account or machine: unreadable by design — skip it */
				}
			}
			return out
		},
		set(name, value) {
			const entries = readEntries()
			if (value === undefined) {
				if (!(name in entries)) return { persisted: true }
				delete entries[name]
				writeEntries(entries)
				return { persisted: true }
			}
			if (!canEncrypt()) return { persisted: false }
			entries[name] = safeStorage.encryptString(value).toString('base64')
			writeEntries(entries)
			return { persisted: true }
		},
	}
}

/** Hand the store to the server — call after `app` is ready (safeStorage needs it) and before importing it. */
export function installSecretStore(): void {
	;(globalThis as Record<symbol, unknown>)[Symbol.for('cascade.secretStore')] = createSecretStore()
}
