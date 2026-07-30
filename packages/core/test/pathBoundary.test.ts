// The WORKING-DIRECTORY boundary in the permission gate (2026-07-28).
//
// Policy split: the sandboxed web builder keeps 'jail' (tools refuse outside paths themselves — its project
// dir is model-writable and it runs `bypass`, so the gate would never object). The VS Code extension uses
// 'prompt': an outside path RESOLVES and this gate asks the user — including for reads and in acceptEdits,
// because leaving the workspace is the user's call, not the mode's. Additional roots (--add-dir)
// silence the prompt.

import { describe, expect, it } from 'vitest'
import { checkPermission, type PermissionState } from '../src/permissions/gate'
import type { Tool } from '../src/tools/Tool'

const read = { name: 'Read', isReadOnly: () => true } as unknown as Tool
const write = { name: 'Write', isReadOnly: () => false } as unknown as Tool

const win = process.platform === 'win32'
const PROJ = win ? 'C:\\proj' : '/proj'
const OUTSIDE = win ? 'C:\\other\\secret.txt' : '/other/secret.txt'
const OTHER_DIR = win ? 'C:\\other' : '/other'

const promptState = (over: Partial<PermissionState> = {}): PermissionState => ({
	mode: 'default',
	allow: new Set(),
	deny: new Set(),
	cwd: PROJ,
	roots: [],
	pathAccess: 'prompt',
	...over,
})

describe('checkPermission — outside-workspace paths are APPROVABLE, not refused', () => {
	it('a READ outside the workspace asks (even a read asks); inside stays silent', () => {
		expect(checkPermission(read, { file_path: OUTSIDE }, promptState())).toBe('ask')
		expect(checkPermission(read, { file_path: 'src/App.tsx' }, promptState())).toBe('allow')
	})

	it('acceptEdits does NOT auto-allow outside the workspace', () => {
		expect(checkPermission(write, { file_path: OUTSIDE }, promptState({ mode: 'acceptEdits' }))).toBe('ask')
		expect(checkPermission(write, { file_path: 'src/App.tsx' }, promptState({ mode: 'acceptEdits' }))).toBe('allow')
	})

	it('an additional root (--add-dir) silences the prompt', () => {
		expect(checkPermission(read, { file_path: OUTSIDE }, promptState({ roots: [OTHER_DIR] }))).toBe('allow')
	})

	it('deny rules still outrank the boundary, and bypass still short-circuits', () => {
		expect(checkPermission(read, { file_path: OUTSIDE }, promptState({ deny: new Set(['Read']) }))).toBe('deny')
		expect(checkPermission(read, { file_path: OUTSIDE }, promptState({ mode: 'bypass' }))).toBe('allow')
	})

	it('JAIL frontends (the web server default) are untouched: no cwd/policy ⇒ no new asking', () => {
		const serverState: PermissionState = { mode: 'bypass', allow: new Set(), deny: new Set() }
		expect(checkPermission(read, { file_path: OUTSIDE }, serverState)).toBe('allow')
		const extensionLikeButJailed: PermissionState = { mode: 'default', allow: new Set(), deny: new Set(), cwd: PROJ }
		expect(checkPermission(read, { file_path: OUTSIDE }, extensionLikeButJailed)).toBe('allow') // gate silent; the TOOL refuses
	})
})
