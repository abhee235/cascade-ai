// wslSandbox.test.ts — ADR-070 step 5: the WSL runtime's pure builders (script/profile composition).
import { describe, expect, it } from 'vitest'
import type { SandboxPolicy } from '@cascade/core'
import { WSL_CONF, bwrapArgsInDistro, buildExecScript, linuxRoot, mountPrelude, projectKey } from '../src/wslSandbox.js'

const winDir = 'C:\\Users\\dev\\cascade-projects\\my app'
const key = projectKey(winDir)
const wsWrite: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: winDir }
const readOnly: SandboxPolicy = { mode: 'read-only', workspaceRoot: winDir }

describe('projectKey — filesystem-safe, same derivation as the Docker volume name', () => {
	it('sanitizes and survives trailing separators', () => {
		expect(projectKey('C:\\projects\\my app')).toBe('my-app')
		expect(projectKey('C:\\projects\\shop\\')).toBe('shop')
		expect(projectKey('')).toBe('project')
	})
})

describe('mountPrelude — the per-exec bridge (VM auto-terminates, mounts drop)', () => {
	const p = mountPrelude(winDir, key)
	it('drvfs-mounts the project dir at its /projects/<key> root, idempotently', () => {
		expect(p).toContain(`mount -t drvfs '${winDir}' '${linuxRoot(key)}'`)
		expect(p).toContain(`mountpoint -q '${linuxRoot(key)}' ||`) // free when the VM is warm
	})
	it('shadows node_modules with a distro-native dir (the 9p-speed Docker lesson)', () => {
		expect(p).toContain(`mount --bind '/var/cascade/nm/${key}' '${linuxRoot(key)}/node_modules'`)
	})
})

describe('bwrapArgsInDistro — linux-side mode meaning (never core writableRoots: those canonicalize on Windows)', () => {
	it('read-only re-binds nothing writable', () => {
		const a = bwrapArgsInDistro(readOnly, key)
		expect(a.join(' ')).toContain('--ro-bind / /')
		expect(a).not.toContain('--bind')
	})
	it('workspace-write re-binds the project root and /tmp — and NO Windows path ever leaks in', () => {
		const a = bwrapArgsInDistro(wsWrite, key)
		expect(a).toContain(linuxRoot(key))
		expect(a).toContain('/tmp')
		expect(a.join(' ')).not.toMatch(/[A-Z]:\\/) // a Windows bind source would make bwrap refuse to start
	})
})

describe('buildExecScript — mount, cd, then the (possibly wrapped) command', () => {
	it('wraps with bwrap when the policy confines and the rootfs carries bwrap', () => {
		const s = buildExecScript(winDir, key, 'npm test', wsWrite, true)
		expect(s.startsWith(mountPrelude(winDir, key))).toBe(true)
		expect(s).toContain('bwrap --ro-bind / /')
		expect(s).toContain('npm test')
	})
	it('runs plainly when bwrap is absent — the VM boundary still holds for the host', () => {
		const s = buildExecScript(winDir, key, 'npm test', wsWrite, false)
		expect(s).not.toContain('bwrap')
		expect(s).toContain(`cd '${linuxRoot(key)}' && npm test`)
	})
	it('danger-full-access never wraps', () => {
		expect(buildExecScript(winDir, key, 'npm test', { mode: 'danger-full-access', workspaceRoot: winDir }, true)).not.toContain('bwrap')
	})
	it('no policy (pre-ADR-070 caller) never wraps', () => {
		expect(buildExecScript(winDir, key, 'npm test', undefined, true)).not.toContain('bwrap')
	})
})

describe('WSL_CONF — the boundary, pinned', () => {
	it('disables automount AND interop (a default distro mounts all of C: and can run .exe)', () => {
		expect(WSL_CONF).toContain('[automount]\nenabled=false')
		expect(WSL_CONF).toContain('[interop]\nenabled=false')
		expect(WSL_CONF).toContain('appendWindowsPath=false')
	})
})
