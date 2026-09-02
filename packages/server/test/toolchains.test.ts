// toolchains.test.ts — ADR-070 step 3: the mise toolchain layer (prefix, probe order, env, config).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { ensureProjectToolchainConfig, findMise, installProjectToolchains, miseEnv, resetToolchainCache, toolchainsDir } from '../src/toolchains.js'

const SAVED = ['CASCADE_TOOLCHAINS_DIR', 'CASCADE_MISE', 'CASCADE_MISE_PATH'] as const
let saved: Record<string, string | undefined>

beforeEach(() => {
	saved = Object.fromEntries(SAVED.map((k) => [k, process.env[k]]))
	for (const k of SAVED) delete process.env[k]
	resetToolchainCache()
})
afterEach(() => {
	for (const k of SAVED) {
		if (saved[k] === undefined) delete process.env[k]
		else process.env[k] = saved[k]
	}
	resetToolchainCache()
})

const tmp = () => mkdtempSync(join(tmpdir(), 'toolchains-'))

/** A fake mise "binary": an existing file — enough for the locate paths, never actually executable. */
function fakeMise(dir: string): string {
	const p = join(dir, process.platform === 'win32' ? 'mise.exe' : 'mise')
	writeFileSync(p, '')
	return p
}

describe('toolchainsDir — the Cascade-owned prefix', () => {
	it('honors the override', () => {
		process.env.CASCADE_TOOLCHAINS_DIR = 'X:\\somewhere\\toolchains'
		expect(toolchainsDir()).toBe('X:\\somewhere\\toolchains')
	})
	it('defaults under the per-user app-data area, never the project or the user tool dirs', () => {
		const dir = toolchainsDir()
		expect(dir).toContain(join('Cascade', 'toolchains'))
	})
})

describe('findMise — probe order and kill-switch', () => {
	it('CASCADE_MISE=0 disables the layer outright', () => {
		process.env.CASCADE_MISE = '0'
		process.env.CASCADE_MISE_PATH = fakeMise(tmp()) // even an explicit path loses to the kill-switch
		expect(findMise()).toBeUndefined()
	})
	it('an explicit CASCADE_MISE_PATH wins (the packaged app points at its bundled binary)', () => {
		const p = fakeMise(tmp())
		process.env.CASCADE_MISE_PATH = p
		expect(findMise()).toBe(p)
	})
	it('a provisioned copy in the prefix is found without configuration', () => {
		const prefix = tmp()
		mkdirSync(join(prefix, 'bin'), { recursive: true })
		const p = fakeMise(join(prefix, 'bin'))
		process.env.CASCADE_TOOLCHAINS_DIR = prefix
		expect(findMise()).toBe(p)
	})
	it('the verdict is cached until reset', () => {
		process.env.CASCADE_MISE = '0'
		expect(findMise()).toBeUndefined()
		delete process.env.CASCADE_MISE
		process.env.CASCADE_MISE_PATH = fakeMise(tmp())
		expect(findMise()).toBeUndefined() // still the cached verdict
		resetToolchainCache()
		expect(findMise()).toBeDefined()
	})
})

describe('miseEnv — the per-spawn activation block', () => {
	it('is EMPTY when mise is absent — the host path stays byte-identical', () => {
		process.env.CASCADE_MISE = '0'
		expect(miseEnv()).toEqual({})
	})
	it('redirects every mise dir into the prefix and prepends the shims dir to PATH', () => {
		const prefix = tmp()
		process.env.CASCADE_TOOLCHAINS_DIR = prefix
		process.env.CASCADE_MISE_PATH = fakeMise(tmp())
		const env = miseEnv()
		expect(env.MISE_DATA_DIR).toBe(join(prefix, 'data'))
		expect(env.MISE_CACHE_DIR).toBe(join(prefix, 'cache'))
		expect(env.MISE_CONFIG_DIR).toBe(join(prefix, 'config'))
		expect(env.PATH!.startsWith(join(prefix, 'data', 'shims') + delimiter)).toBe(true)
		expect(env.PATH).toContain(process.env.PATH ?? '') // falls through to the host PATH after shims
	})
	it("puts an explicitly located binary's own dir on PATH — shims re-exec `mise` and a bundled binary isn't on the user PATH", () => {
		const miseDir = tmp()
		process.env.CASCADE_MISE_PATH = fakeMise(miseDir)
		expect(miseEnv().PATH).toContain(`${delimiter}${miseDir}${delimiter}`)
	})
})

describe('ensureProjectToolchainConfig — projects declare their toolchains', () => {
	it('writes mise.toml once (node pinned to LTS), then leaves it to the project', () => {
		process.env.CASCADE_MISE_PATH = fakeMise(tmp())
		const project = tmp()
		expect(ensureProjectToolchainConfig(project)).toBe(true)
		expect(readFileSync(join(project, 'mise.toml'), 'utf8')).toContain('node = "lts"')
		expect(ensureProjectToolchainConfig(project)).toBe(false) // idempotent — never overwrites
	})
	it('respects an existing .mise.toml spelling', () => {
		process.env.CASCADE_MISE_PATH = fakeMise(tmp())
		const project = tmp()
		writeFileSync(join(project, '.mise.toml'), '[tools]\n')
		expect(ensureProjectToolchainConfig(project)).toBe(false)
	})
	it('writes nothing when the layer is dormant — no clutter in projects mise will never serve', () => {
		process.env.CASCADE_MISE = '0'
		const project = tmp()
		expect(ensureProjectToolchainConfig(project)).toBe(false)
		expect(existsSync(join(project, 'mise.toml'))).toBe(false)
	})
})

// ── Live E2E (opt-in: CASCADE_MISE_LIVE=1, real mise on PATH required) — the ADR-070 step-3 done-when:
//    an install lands in the Cascade prefix, never in the user's own dirs, and the tool then resolves
//    through the layer's PATH. Uses jq (a ~2 MB single binary) rather than node to keep the run fast. ──
describe.runIf(process.env.CASCADE_MISE_LIVE === '1')('live: mise provisions into the Cascade prefix', () => {
	it('installs a declared tool under the prefix and resolves it via miseEnv PATH', async () => {
		const { spawnSync } = await import('node:child_process')
		const prefix = tmp()
		process.env.CASCADE_TOOLCHAINS_DIR = prefix
		// The isolation beforeEach wipes CASCADE_MISE_PATH; a live run legitimately supplies it from outside.
		if (saved.CASCADE_MISE_PATH) process.env.CASCADE_MISE_PATH = saved.CASCADE_MISE_PATH
		resetToolchainCache()
		expect(findMise()).toBeDefined() // live run requires a real mise
		const project = tmp()
		writeFileSync(join(project, 'mise.toml'), '[tools]\njq = "latest"\n')
		let log = ''
		const ok = await installProjectToolchains(project, (c) => {
			log += c
		})
		expect(ok, log).toBe(true)
		// The install landed under OUR prefix (data dir), not the user's ~/.local/share/mise.
		expect(existsSync(join(prefix, 'data'))).toBe(true)
		// And the tool resolves through the layer's env from inside the project.
		const probe = spawnSync('jq', ['--version'], { cwd: project, env: { ...process.env, ...miseEnv() }, encoding: 'utf8', shell: true, timeout: 30_000 })
		expect(probe.status, probe.stderr).toBe(0)
	}, 180_000)
})

describe('installProjectToolchains — best-effort by design', () => {
	it('no mise ⇒ nothing to do ⇒ true', async () => {
		process.env.CASCADE_MISE = '0'
		await expect(installProjectToolchains(tmp())).resolves.toBe(true)
	})
	it('no declaration ⇒ nothing to do ⇒ true (never spawns)', async () => {
		process.env.CASCADE_MISE_PATH = fakeMise(tmp()) // a non-executable fake — a spawn would fail loudly
		await expect(installProjectToolchains(tmp())).resolves.toBe(true)
	})
	it('a failed install resolves false instead of throwing — degraded, not broken', async () => {
		process.env.CASCADE_MISE_PATH = fakeMise(tmp()) // exists for the probe, not executable for the spawn
		const project = tmp()
		writeFileSync(join(project, 'mise.toml'), '[tools]\nnode = "lts"\n')
		await expect(installProjectToolchains(project)).resolves.toBe(false)
	})
})
