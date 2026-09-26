// wslSandbox.live.test.ts — ADR-070 step 5 E2E (explicit opt-in: CASCADE_WSL_LIVE=1 + a built rootfs).
//
//   .\scripts\build-wsl-rootfs.ps1
//   $env:CASCADE_WSL_LIVE='1'; $env:CASCADE_WSL_ROOTFS='<repo>\dist\wsl\cascade-sandbox-rootfs.tar'
//   npx vitest run packages/server/test/wslSandbox.live.test.ts
//
// Opt-in by env (not a passive probe gate) because it CHANGES SYSTEM STATE: first run imports the
// cascade-sandbox distro. What it pins is the ADR's step-5 done-when, for real: silent import +
// verified boundary, the provisioned toolchain present, the drvfs bridge (in-VM writes land in the
// host project dir; node_modules does NOT — the distro-native shadow), host FS unreachable from
// inside, and read-only policy enforced by bwrap inside the VM.
import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SandboxPolicy } from '@cascade/core'
import { WslSandbox, ensureDistro, resetWslCache } from '../src/wslSandbox.js'

const optedIn = process.env.CASCADE_WSL_LIVE === '1' && process.platform === 'win32'

describe.runIf(optedIn)('live: the cascade-sandbox WSL runtime end-to-end', () => {
	const projectDir = mkdtempSync(join(tmpdir(), 'wsl-live-'))
	const wsWrite: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: projectDir }
	const readOnly: SandboxPolicy = { mode: 'read-only', workspaceRoot: projectDir }
	const sandbox = new WslSandbox(projectDir)

	it('imports (if needed), configures, and VERIFIES the distro boundary', () => {
		resetWslCache()
		expect(ensureDistro()).toBe('ready')
	}, 300_000)

	it('the rootfs carries the whole provisioned toolchain', async () => {
		const r = await sandbox.exec('node --version && python3 --version && bwrap --version && mise --version', { policy: wsWrite })
		expect(r.exitCode, r.output).toBe(0)
		expect(r.output).toMatch(/v\d+\./) // node
		expect(r.output).toMatch(/Python 3/)
	}, 120_000)

	it('host filesystem is UNREACHABLE from inside (the hermetic boundary)', async () => {
		const r = await sandbox.exec('test -e /mnt/c/Windows', { policy: wsWrite })
		expect(r.exitCode).not.toBe(0)
	}, 60_000)

	it('the drvfs bridge: an in-VM write lands in the HOST project dir', async () => {
		const r = await sandbox.exec('echo from-inside > bridge.txt', { policy: wsWrite })
		expect(r.exitCode, r.output).toBe(0)
		expect(existsSync(join(projectDir, 'bridge.txt'))).toBe(true)
	}, 60_000)

	it('read-only policy is enforced INSIDE the VM by bwrap (defense in depth)', async () => {
		const r = await sandbox.exec('touch ro-escape.txt', { policy: readOnly })
		expect(r.exitCode).not.toBe(0)
		expect(existsSync(join(projectDir, 'ro-escape.txt'))).toBe(false)
		const low = r.output.toLowerCase()
		expect(sandbox.denialSignatures.some((s) => low.includes(s))).toBe(true) // step-2 classifier engages
	}, 60_000)

	it('npm install works; node_modules stays in the distro-native shadow, invisible to the host', async () => {
		writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ name: 'wsl-live', version: '1.0.0', dependencies: { 'left-pad': '1.3.0' } }))
		expect(await sandbox.hasDependencies()).toBe(false)
		let log = ''
		expect(await sandbox.installDependencies((c) => (log += c)), log).toBe(true)
		expect(await sandbox.hasDependencies()).toBe(true) // populated — answered from INSIDE
		// The mount POINT exists on the host (the prelude's mkdir -p writes through drvfs — the same empty
		// dir a Docker bind+volume leaves), but the CONTENTS live in the distro-native shadow: the installed
		// package must never appear host-side.
		expect(existsSync(join(projectDir, 'node_modules', 'left-pad'))).toBe(false)
		// And the installed dep actually resolves for in-VM node:
		const r = await sandbox.exec(`node -e "console.log(require('left-pad')('5', 3, '0'))"`, { policy: wsWrite })
		expect(r.exitCode, r.output).toBe(0)
		expect(r.output).toContain('005')
	}, 300_000)

	it('python runs a real script inside (the any-language criterion)', async () => {
		const r = await sandbox.exec(`python3 -c "print('py-' + str(21 * 2))"`, { policy: wsWrite })
		expect(r.exitCode, r.output).toBe(0)
		expect(r.output).toContain('py-42')
	}, 60_000)
})

describe.runIf(!optedIn)('live WSL suite', () => {
	it.skip('opt-in: CASCADE_WSL_LIVE=1 + CASCADE_WSL_ROOTFS (see scripts/build-wsl-rootfs.ps1)', () => {})
})
