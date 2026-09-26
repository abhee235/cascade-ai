// wslSandbox.test.ts — ADR-070 step 5: the WSL runtime's pure builders (script/profile composition).
import { describe, expect, it } from 'vitest'
import type { SandboxPolicy } from '@cascade/core'
import { WSL_CONF, buildDevScript, bwrapArgsInDistro, buildExecScript, linuxHome, linuxRoot, mountPrelude, projectKey } from '../src/wslSandbox.js'

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
	it('creates the per-project writable HOME (npm/mise write there, not the project folder)', () => {
		expect(p).toContain(shqLike(linuxHome(key)))
	})
})

/** The prelude quotes every path; assert on the quoted form the script actually contains. */
function shqLike(s: string): string {
	return `'${s}'`
}

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
	// Regression, measured live 2026-09-16: without a writable HOME the first `npm install` inside the
	// fence died `EROFS /root/.npm/_cacache` and the model escalated to danger-full-access to get a cache.
	it('workspace-write re-binds the project HOME so a build can write its package cache', () => {
		expect(bwrapArgsInDistro(wsWrite, key)).toContain(linuxHome(key))
	})
	it('read-only does NOT get a writable HOME — no writes means no cache writes either', () => {
		expect(bwrapArgsInDistro(readOnly, key)).not.toContain(linuxHome(key))
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
		expect(s).toContain(`cd '${linuxRoot(key)}' && export HOME='${linuxHome(key)}' && npm test`)
	})
	it('always exports the writable HOME — confined and unconfined share one warm cache', () => {
		for (const wrapped of [true, false]) {
			const s = buildExecScript(winDir, key, 'npm install', wsWrite, wrapped)
			// Quoting differs by branch: the confined one passes the inner script through shq(), so the
			// single quotes come back as '\''. Assert on what must survive either way, not on one spelling.
			expect(s).toContain('export HOME=')
			expect(s).toContain(linuxHome(key))
		}
	})
	it('danger-full-access never wraps', () => {
		expect(buildExecScript(winDir, key, 'npm test', { mode: 'danger-full-access', workspaceRoot: winDir }, true)).not.toContain('bwrap')
	})
	it('no policy (pre-ADR-070 caller) never wraps', () => {
		expect(buildExecScript(winDir, key, 'npm test', undefined, true)).not.toContain('bwrap')
	})
})

describe('buildDevScript — the `&` vs `&&` precedence trap', () => {
	// Measured 2026-09-16: `mount && cd && setsid … & echo $!` backgrounds the WHOLE chain, so wsl.exe
	// returned before it reached vite. Symptom: a fresh dev.pid, NO dev.log, and every Browser/Preview
	// call failing with "the dev server did not answer within 30s".
	it('groups the detached launch so mount/cd stay in the FOREGROUND', () => {
		const s = buildDevScript(winDir, key, 52926, {})
		expect(s).toContain('{ setsid')
		expect(s).toContain('; }')
		// The mount must happen BEFORE the background group — never swallowed into it.
		expect(s.indexOf('mount -t drvfs')).toBeLessThan(s.indexOf('{ setsid'))
		// Exactly one `&` that backgrounds, and it lives inside the braces.
		expect(s.slice(s.indexOf('{ setsid'))).toContain('2>&1 &')
	})
	it('writes log and pid inside the project, and passes env + port through', () => {
		const s = buildDevScript(winDir, key, 4321, { CHOKIDAR_USEPOLLING: 'true' })
		expect(s).toContain("CHOKIDAR_USEPOLLING='true'")
		expect(s).toContain('> .cascade/dev.log 2>&1')
		expect(s).toContain('echo $! > .cascade/dev.pid')
		expect(s).toContain('--port 4321')
	})
})

describe('WSL_CONF — the boundary, pinned', () => {
	it('disables automount AND interop (a default distro mounts all of C: and can run .exe)', () => {
		expect(WSL_CONF).toContain('[automount]\nenabled=false')
		expect(WSL_CONF).toContain('[interop]\nenabled=false')
		expect(WSL_CONF).toContain('appendWindowsPath=false')
	})
})
