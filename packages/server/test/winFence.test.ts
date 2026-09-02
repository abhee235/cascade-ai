// winFence.test.ts — ADR-070 step 6: the write-fence's pure parts (SID, runner argv, backend wiring).
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SandboxPolicy } from '@cascade/core'
import { tempWriteSid, workspaceWriteSid } from '../src/winFenceSid.js'
import { buildChildCommandLine, parseRunnerArgs } from '../src/winFenceRunner.js'
import { confineHostCommand, resetBackendCache, selectLocalBackend } from '../src/sandboxBackends.js'

const ws = mkdtempSync(join(tmpdir(), 'winfence-'))
const wsWrite: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: ws }
const readOnly: SandboxPolicy = { mode: 'read-only', workspaceRoot: ws }

describe('SID derivation — deterministic, path-scoped, domain-separated', () => {
	it('the same canonical workspace path always yields the same SID (the standing-ACE reuse cache)', () => {
		expect(workspaceWriteSid(ws)).toBe(workspaceWriteSid(ws))
	})
	it('different workspaces yield different SIDs', () => {
		const other = mkdtempSync(join(tmpdir(), 'winfence2-'))
		expect(workspaceWriteSid(ws)).not.toBe(workspaceWriteSid(other))
	})
	it('workspace SIDs are S-1-4-a-b; temp SIDs add a third subauthority so they can never collide', () => {
		expect(workspaceWriteSid(ws)).toMatch(/^S-1-4-\d+-\d+$/)
		expect(tempWriteSid(ws)).toMatch(/^S-1-4-\d+-\d+-1$/)
	})
})

describe('parseRunnerArgs — the runner contract', () => {
	it('parses a workspace-write invocation', () => {
		const p = parseRunnerArgs(['--workspace', ws, '--mode', 'workspace-write', '--write-sid', 'S-1-4-1-2', '--temp-dir', 'T', '--', 'npm test'])
		expect(p).toMatchObject({ workspace: ws, mode: 'workspace-write', writeSid: 'S-1-4-1-2', tempDir: 'T', command: ['npm test'] })
	})
	it('requires a write-sid under workspace-write', () => {
		expect(() => parseRunnerArgs(['--workspace', ws, '--mode', 'workspace-write', '--', 'x'])).toThrow(/requires --write-sid/)
	})
	it('read-only needs no sid', () => {
		expect(parseRunnerArgs(['--workspace', ws, '--mode', 'read-only', '--', 'ls']).mode).toBe('read-only')
	})
	it('rejects a missing `--` and an empty command', () => {
		expect(() => parseRunnerArgs(['--workspace', ws, '--mode', 'read-only', 'ls'])).toThrow(/missing `--`/)
		expect(() => parseRunnerArgs(['--workspace', ws, '--mode', 'read-only', '--'])).toThrow(/no command/)
	})
})

describe('buildChildCommandLine — cmd /d /s /c wrapper', () => {
	it('wraps the single command element, outer-quoted for cmd /s', () => {
		const line = buildChildCommandLine(['echo hi && dir'])
		expect(line).toMatch(/\/d \/s \/c "echo hi && dir"$/)
	})
})

describe('backend selection — win32 chain', () => {
	it('win32 selects the fence when its probe passes, none when it fails', () => {
		expect(selectLocalBackend({ platform: 'win32', probeWinFence: () => true })).toBe('win-write-fence')
		expect(selectLocalBackend({ platform: 'win32', probeWinFence: () => false })).toBe('none')
		resetBackendCache()
	})
})

describe('confineHostCommand — the fence is argv-form, partial, with a runner-failure signature', () => {
	it('workspace-write: argv runs the runner with the workspace SID + temp-dir; command is ONE trailing element', () => {
		const c = confineHostCommand('npm run build', wsWrite, { platform: 'win32', probeWinFence: () => true })
		resetBackendCache()
		expect(c.backend).toBe('win-write-fence')
		expect(c.enforcement).toBe('partial') // honest: writes only, plus Everyone/hard-link boundaries
		expect(c.argv).toBeDefined()
		const argv = c.argv!
		expect(argv).toContain('--write-sid')
		expect(argv).toContain(workspaceWriteSid(ws))
		expect(argv).toContain('--temp-dir')
		expect(argv[argv.length - 2]).toBe('--')
		expect(argv[argv.length - 1]).toBe('npm run build') // never split/reshelled
		expect(c.runnerFailureSignatures).toContain('cascade-fence:')
	})
	it('read-only: argv carries no write-sid (nothing is grantable)', () => {
		const c = confineHostCommand('ls', readOnly, { platform: 'win32', probeWinFence: () => true })
		resetBackendCache()
		expect(c.argv).not.toContain('--write-sid')
		expect(c.argv![c.argv!.length - 1]).toBe('ls')
	})
	it('danger-full-access is never confined', () => {
		expect(confineHostCommand('rm -rf /', { mode: 'danger-full-access', workspaceRoot: ws }, { platform: 'win32', probeWinFence: () => true }).backend).toBe('none')
	})
})
