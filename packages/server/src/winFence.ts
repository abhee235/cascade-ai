// winFence.ts — the Win32 FFI core of the Windows write-fence (ADR-070 step 6, ADR-087). Token creation and
// the confined spawn run in the RUNNER process (winFenceRunner.ts), never in the server; the server only sets
// the workspace's label (labelLowIntegrity). koffi binds the handful of advapi32/kernel32 calls involved.
//
// workspace-write (ADR-087): the caller's token, privileges stripped, lowered to the LOW integrity level.
// Windows' No-Write-Up policy then denies every write to an object not labeled low — the user's files, other
// folders, other processes — and the workspace carries a standing, inheritable low label, so it is the one
// tree the child may write. The child's own new objects (its stdio pipes, files, temp) are low as well, so a
// child that spawns grandchildren with piped stdio — esbuild, npm scripts, any node child — works. The
// WRITE_RESTRICTED design this replaced failed every such spawn: node creates each stdio pipe as a NAMED pipe,
// whose fixed default DACL (Everyone: read) no restricting SID could write — `spawn EPERM` (measured 2026-09-29).
//
// read-only: a WRITE_RESTRICTED token whose restricting-SID list is the keep-alive pair (logon SID +
// Everyone). Windows checks every write twice — the object's DACL AND that list — and the list grants nothing
// writable; the workspace's low label grants nothing to this medium-integrity token either.
//
// Both modes leave reads, exec and network open — why arbitrary toolchains work, and why the rung reports
// `partial`. EVERY Win32 call is checked and throws Win32Error on failure — fail-closed by construction. The
// public POC the first version followed ignored return values and, when token creation failed, silently ran
// the child with the FULL unrestricted token; this port never does.

import koffi from 'koffi'

// ── Win32 constants ─────────────────────────────────────────────────────────────────────────────────
const TOKEN_QUERY = 0x0008
const TOKEN_DUPLICATE = 0x0002
const TOKEN_ASSIGN_PRIMARY = 0x0001
const TOKEN_ADJUST_DEFAULT = 0x0080
const PROCESS_QUERY_INFORMATION = 0x0400
const DISABLE_MAX_PRIVILEGE = 0x1
const WRITE_RESTRICTED = 0x8
const LUA_TOKEN = 0x4
const SE_GROUP_LOGON_ID = 0xc0000000 // attribute bits marking the logon-session SID group
const TokenGroups = 2
const TokenIntegrityLevel = 25
const SE_GROUP_INTEGRITY = 0x20 // the attribute a TOKEN_MANDATORY_LABEL's SID carries
const ERROR_INSUFFICIENT_BUFFER = 122
const ERROR_SUCCESS = 0
const SE_FILE_OBJECT = 1
const LABEL_SECURITY_INFORMATION = 0x10
const SDDL_REVISION_1 = 1
const CREATE_UNICODE_ENVIRONMENT = 0x00000400
const INFINITE = 0xffffffff
const SECURITY_MAX_SID_SIZE = 68
const WinWorldSid = 1 // Everyone
/** The Low mandatory level — what a workspace-write child runs at (ADR-087). */
const LOW_INTEGRITY_SID = 'S-1-16-4096'
/** The workspace's label: Low, No-Write-Up, inherited by every file (OI) and folder (CI) below it. */
const LOW_LABEL_ACE = '(ML;OICI;NW;;;LW)'

// ── struct layouts ──────────────────────────────────────────────────────────────────────────────────
// SID_AND_ATTRIBUTES { PSID Sid; DWORD Attributes; } — 8-byte pointer + 4-byte dword, 8-byte aligned = 16.
const SID_AND_ATTRIBUTES = koffi.struct('SID_AND_ATTRIBUTES', { Sid: 'void*', Attributes: 'uint32' })
// STARTUPINFOW — only cb matters here (72 bytes on x64); the rest stay zero.
const STARTUPINFOW = koffi.struct('STARTUPINFOW', {
	cb: 'uint32',
	lpReserved: 'void*',
	lpDesktop: 'void*',
	lpTitle: 'void*',
	dwX: 'uint32',
	dwY: 'uint32',
	dwXSize: 'uint32',
	dwYSize: 'uint32',
	dwXCountChars: 'uint32',
	dwYCountChars: 'uint32',
	dwFillAttribute: 'uint32',
	dwFlags: 'uint32',
	wShowWindow: 'uint16',
	cbReserved2: 'uint16',
	lpReserved2: 'void*',
	hStdInput: 'void*',
	hStdOutput: 'void*',
	hStdError: 'void*',
})
const PROCESS_INFORMATION = koffi.struct('PROCESS_INFORMATION', {
	hProcess: 'void*',
	hThread: 'void*',
	dwProcessId: 'uint32',
	dwThreadId: 'uint32',
})

// ── library bindings (LAZY — koffi.load('advapi32.dll') would throw on non-Windows, and this module is
//    imported by sandboxBackends on every platform; the DLLs load only when a fence function first runs,
//    which is only on win32 when the fence is actually selected) ────────────────────────────────────────
type Bindings = ReturnType<typeof bindNow>
let cachedBindings: Bindings | undefined
function bindNow() {
	const advapi32 = koffi.load('advapi32.dll')
	const kernel32 = koffi.load('kernel32.dll')
	return {
		GetCurrentProcess: kernel32.func('void* GetCurrentProcess()'),
		GetLastError: kernel32.func('uint32 GetLastError()'),
		CloseHandle: kernel32.func('int CloseHandle(void* h)'),
		WaitForSingleObject: kernel32.func('uint32 WaitForSingleObject(void* h, uint32 ms)'),
		GetExitCodeProcess: kernel32.func('int GetExitCodeProcess(void* h, _Out_ uint32* code)'),
		GetStdHandle: kernel32.func('void* GetStdHandle(uint32 which)'),
		SetHandleInformation: kernel32.func('int SetHandleInformation(void* h, uint32 mask, uint32 flags)'),
		FormatMessageW: kernel32.func('uint32 FormatMessageW(uint32 flags, void* src, uint32 msgId, uint32 langId, _Out_ uint16* buf, uint32 size, void* args)'),
		LocalFree: kernel32.func('void* LocalFree(void* p)'),
		OpenProcessToken: advapi32.func('int OpenProcessToken(void* proc, uint32 access, _Out_ void** token)'),
		CreateRestrictedToken: advapi32.func(
			'int CreateRestrictedToken(void* existing, uint32 flags, uint32 nSidsToDisable, void* sidsToDisable, uint32 nPrivToDelete, void* privToDelete, uint32 nSidsToRestrict, void* sidsToRestrict, _Out_ void** newToken)',
		),
		GetTokenInformation: advapi32.func('int GetTokenInformation(void* token, int cls, void* info, uint32 len, _Out_ uint32* retLen)'),
		SetTokenInformation: advapi32.func('int SetTokenInformation(void* token, int cls, void* info, uint32 len)'),
		GetLengthSid: advapi32.func('uint32 GetLengthSid(void* sid)'),
		CopySid: advapi32.func('int CopySid(uint32 destLen, void* dest, void* src)'),
		CreateWellKnownSid: advapi32.func('int CreateWellKnownSid(int type, void* domainSid, _Out_ void* sid, _Inout_ uint32* size)'),
		ConvertStringSidToSidW: advapi32.func('int ConvertStringSidToSidW(str16 sddl, _Out_ void** sid)'),
		SetNamedSecurityInfoW: advapi32.func('uint32 SetNamedSecurityInfoW(str16 name, int objType, uint32 secInfo, void* owner, void* group, void* dacl, void* sacl)'),
		GetNamedSecurityInfoW: advapi32.func(
			'uint32 GetNamedSecurityInfoW(str16 name, int objType, uint32 secInfo, void* owner, void* group, void* dacl, _Out_ void** sacl, _Out_ void** sd)',
		),
		ConvertStringSecurityDescriptorToSecurityDescriptorW: advapi32.func(
			'int ConvertStringSecurityDescriptorToSecurityDescriptorW(str16 sddl, uint32 revision, _Out_ void** sd, _Out_ uint32* size)',
		),
		ConvertSecurityDescriptorToStringSecurityDescriptorW: advapi32.func(
			'int ConvertSecurityDescriptorToStringSecurityDescriptorW(void* sd, uint32 revision, uint32 secInfo, _Out_ void** sddl, _Out_ uint32* len)',
		),
		GetSecurityDescriptorSacl: advapi32.func('int GetSecurityDescriptorSacl(void* sd, _Out_ int* present, _Out_ void** sacl, _Out_ int* defaulted)'),
		CreateProcessAsUserW: advapi32.func(
			'int CreateProcessAsUserW(void* token, str16 appName, _Inout_ uint16* cmdLine, void* procAttrs, void* threadAttrs, int inheritHandles, uint32 flags, void* env, str16 cwd, void* startupInfo, _Out_ void* procInfo)',
		),
	}
}
function w32(): Bindings {
	cachedBindings ??= bindNow()
	return cachedBindings
}

// ── error handling ──────────────────────────────────────────────────────────────────────────────────
const FORMAT_MESSAGE_FROM_SYSTEM = 0x1000
const FORMAT_MESSAGE_IGNORE_INSERTS = 0x200

export class Win32Error extends Error {
	constructor(
		readonly api: string,
		readonly code: number,
		readonly context?: string,
	) {
		super(`${api} failed (Win32 ${code}: ${win32Message(code)})${context ? ` — ${context}` : ''}`)
		this.name = 'Win32Error'
	}
}

function win32Message(code: number): string {
	const buf = new Uint16Array(512)
	const n = w32().FormatMessageW(FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS, null, code, 0, buf, buf.length, null)
	return n > 0 ? koffi.decode(buf, 'char16', n).replace(/[\r\n]+$/, '') : `unknown error ${code}`
}

/** Throw on a zero (failure) return from a bool-returning Win32 call, tagging GetLastError. */
function checkBool(ok: number, api: string, context?: string): void {
	if (ok === 0) throw new Win32Error(api, w32().GetLastError(), context)
}

// ── SID helpers ─────────────────────────────────────────────────────────────────────────────────────
/** "S-1-4-x-y" → an owned SID buffer (LocalAlloc'd by Windows; freed on process exit — the runner is
 *  short-lived, so we deliberately do not track every allocation for release). */
function sidFromString(sddl: string): unknown {
	const out = [null] as unknown[]
	checkBool(w32().ConvertStringSidToSidW(sddl, out), 'ConvertStringSidToSidW', sddl)
	return out[0]
}

/** The Everyone (World) SID as a fresh buffer. */
function everyoneSid(): Uint8Array {
	const sid = new Uint8Array(SECURITY_MAX_SID_SIZE)
	const size = [SECURITY_MAX_SID_SIZE] as number[]
	checkBool(w32().CreateWellKnownSid(WinWorldSid, null, sid, size), 'CreateWellKnownSid', 'WinWorldSid')
	return sid
}

/** The token's logon-session SID (SE_GROUP_LOGON_ID) — required in the restricting list for WinSta0/desktop
 *  and other per-logon objects, or the child dies during DLL init. Copied out of the TokenGroups blob. */
function logonSid(token: unknown): Uint8Array {
	const retLen = [0] as number[]
	w32().GetTokenInformation(token, TokenGroups, null, 0, retLen) // sizing call — expected to "fail" with ERROR_INSUFFICIENT_BUFFER
	const needed = retLen[0]
	if (needed === 0) throw new Win32Error('GetTokenInformation', w32().GetLastError(), 'TokenGroups size query')
	const buf = new Uint8Array(needed)
	checkBool(w32().GetTokenInformation(token, TokenGroups, buf, needed, retLen), 'GetTokenInformation', 'TokenGroups')
	const view = new DataView(buf.buffer)
	const count = view.getUint32(0, true)
	// TOKEN_GROUPS { DWORD GroupCount; SID_AND_ATTRIBUTES Groups[]; } — Groups start at offset 8 (4-byte
	// count + 4 padding for 8-byte alignment of the first pointer), each entry 16 bytes.
	for (let i = 0; i < count; i++) {
		const base = 8 + i * 16
		const attrs = view.getUint32(base + 8, true)
		if ((attrs & SE_GROUP_LOGON_ID) >>> 0) {
			const sidPtr = koffi.decode(buf.subarray(base), 'void*') as unknown
			const len = w32().GetLengthSid(sidPtr)
			if (len === 0) throw new Win32Error('GetLengthSid', w32().GetLastError(), 'logon SID')
			const copy = new Uint8Array(len)
			checkBool(w32().CopySid(len, copy, sidPtr), 'CopySid', 'logon SID')
			return copy
		}
	}
	throw new Error('winFence: no logon SID found in the token groups')
}

// ── the fence ───────────────────────────────────────────────────────────────────────────────────────

export interface FenceOptions {
	mode: 'read-only' | 'workspace-write'
}

/**
 * Build the child's token for `mode`; return it plus the buffers it references (keep them alive while it
 * lives). workspace-write: our token, privileges stripped, lowered to Low integrity — the workspace's
 * standing low label (labelLowIntegrity, set once by the server) is what makes that tree writable.
 * read-only: WRITE_RESTRICTED with only the keep-alive pair. Fail-closed: any Win32 failure throws before a
 * child is ever spawned.
 */
export function buildRestrictedToken(opts: FenceOptions): { token: unknown; keepAlive: unknown[] } {
	const procTokenOut = [null] as unknown[]
	checkBool(
		w32().OpenProcessToken(w32().GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT, procTokenOut),
		'OpenProcessToken',
	)
	const procToken = procTokenOut[0]
	const keepAlive: unknown[] = []
	const tokenOut = [null] as unknown[]
	if (opts.mode === 'workspace-write') {
		// A CHILD of our own token (CreateRestrictedToken, no SID restricted), so CreateProcessAsUser needs no
		// privilege — then lowered. Lowering is always allowed; only raising needs SeRelabelPrivilege.
		checkBool(w32().CreateRestrictedToken(procToken, DISABLE_MAX_PRIVILEGE | LUA_TOKEN, 0, null, 0, null, 0, null, tokenOut), 'CreateRestrictedToken', 'low integrity')
		setIntegrityLevel(tokenOut[0], LOW_INTEGRITY_SID)
	} else {
		// Restricting list: the keep-alive pair (DLL init and CNG die without them) — it grants nothing writable.
		const sids: unknown[] = [logonSid(procToken), everyoneSid()]
		// Pack SID_AND_ATTRIBUTES[]: one 16-byte entry per SID, Attributes = 0.
		const arr = new Uint8Array(sids.length * 16)
		for (let i = 0; i < sids.length; i++) koffi.encode(arr.subarray(i * 16), 'void*', sids[i])
		keepAlive.push(...sids, arr)
		checkBool(
			w32().CreateRestrictedToken(procToken, DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED, 0, null, 0, null, sids.length, arr, tokenOut),
			'CreateRestrictedToken',
			`${sids.length} restricting SIDs`,
		)
	}
	w32().CloseHandle(procToken)
	return { token: tokenOut[0], keepAlive }
}

/** Set `token`'s mandatory integrity level. TOKEN_MANDATORY_LABEL { SID_AND_ATTRIBUTES Label } is a SID
 *  pointer + SE_GROUP_INTEGRITY; the length covers the struct AND the SID it points to. */
function setIntegrityLevel(token: unknown, levelSid: string): void {
	const sid = sidFromString(levelSid)
	const label = new Uint8Array(16)
	koffi.encode(label, 'void*', sid)
	new DataView(label.buffer).setUint32(8, SE_GROUP_INTEGRITY, true)
	checkBool(w32().SetTokenInformation(token, TokenIntegrityLevel, label, 16 + w32().GetLengthSid(sid)), 'SetTokenInformation', `integrity level ${levelSid}`)
}

/**
 * Give `dir` the workspace's standing label — Low, No-Write-Up, inherited by everything below it (ADR-087):
 * the low-integrity child may write exactly the objects that carry it. SetNamedSecurityInfo propagates the
 * inheritable label through the existing tree (one full walk, as the write ACE it replaced did; it does not
 * follow junctions), and the label STANDS: a later session or restart finds it on the root and skips the
 * walk. A label no higher than our own level needs only WRITE_OWNER, which a project folder's owner has.
 * Fail-closed: any failure throws, so a command never runs against a half-labeled tree unannounced.
 */
export function labelLowIntegrity(dir: string): void {
	if (hasLowLabel(dir)) return
	const sdOut = [null] as unknown[]
	checkBool(w32().ConvertStringSecurityDescriptorToSecurityDescriptorW(`S:${LOW_LABEL_ACE}`, SDDL_REVISION_1, sdOut, [0]), 'ConvertStringSecurityDescriptorToSecurityDescriptorW', LOW_LABEL_ACE)
	try {
		const saclOut = [null] as unknown[]
		checkBool(w32().GetSecurityDescriptorSacl(sdOut[0], [0], saclOut, [0]), 'GetSecurityDescriptorSacl', LOW_LABEL_ACE)
		const r = w32().SetNamedSecurityInfoW(dir, SE_FILE_OBJECT, LABEL_SECURITY_INFORMATION, null, null, null, saclOut[0])
		if (r !== ERROR_SUCCESS) throw new Win32Error('SetNamedSecurityInfoW', r, dir)
	} finally {
		w32().LocalFree(sdOut[0])
	}
}

/**
 * Take the workspace label back off `dir` (ADR-087 amendment, 2026-10-06): an EMPTY label set, propagated, drops
 * the inherited low label from every object below — measured, including files the low child CREATED while it held
 * the label, so nothing it wrote stays writable to the next low process. A no-op on a root that is not labeled.
 * Called when the last sandbox holding the workspace is disposed, and by the startup sweep after a crash.
 */
export function unlabelLowIntegrity(dir: string): void {
	if (!hasLowLabel(dir)) return
	const sdOut = [null] as unknown[]
	checkBool(w32().ConvertStringSecurityDescriptorToSecurityDescriptorW('S:', SDDL_REVISION_1, sdOut, [0]), 'ConvertStringSecurityDescriptorToSecurityDescriptorW', 'empty label set')
	try {
		const saclOut = [null] as unknown[]
		checkBool(w32().GetSecurityDescriptorSacl(sdOut[0], [0], saclOut, [0]), 'GetSecurityDescriptorSacl', 'empty label set')
		const r = w32().SetNamedSecurityInfoW(dir, SE_FILE_OBJECT, LABEL_SECURITY_INFORMATION, null, null, null, saclOut[0])
		if (r !== ERROR_SUCCESS) throw new Win32Error('SetNamedSecurityInfoW', r, dir)
	} finally {
		w32().LocalFree(sdOut[0])
	}
}

/** Does `dir` itself carry the workspace label? Explicit only — an inherited one reads `(ML;OICIID;…)`, and a
 *  root that merely inherits a label from somewhere above is not a workspace we labeled. */
export function hasLowLabel(dir: string): boolean {
	const sdOut = [null] as unknown[]
	const r = w32().GetNamedSecurityInfoW(dir, SE_FILE_OBJECT, LABEL_SECURITY_INFORMATION, null, null, null, [null], sdOut)
	if (r !== ERROR_SUCCESS) throw new Win32Error('GetNamedSecurityInfoW', r, dir)
	try {
		const strOut = [null] as unknown[]
		const lenOut = [0] as number[]
		checkBool(
			w32().ConvertSecurityDescriptorToStringSecurityDescriptorW(sdOut[0], SDDL_REVISION_1, LABEL_SECURITY_INFORMATION, strOut, lenOut),
			'ConvertSecurityDescriptorToStringSecurityDescriptorW',
			dir,
		)
		const sddl = koffi.decode(strOut[0], 'char16', lenOut[0]) as string
		w32().LocalFree(strOut[0])
		return sddl.includes(LOW_LABEL_ACE)
	} finally {
		w32().LocalFree(sdOut[0])
	}
}

/**
 * Spawn `commandLine` under `token` in `cwd`, inheriting this process's stdio, and return its exit code.
 * A restricted token derived from the caller's own token needs no special privilege for
 * CreateProcessAsUser. cmdLine must be a MUTABLE buffer — the API writes into it.
 */
const STD_INPUT_HANDLE = 0xfffffff6 // -10
const STD_OUTPUT_HANDLE = 0xfffffff5 // -11
const STD_ERROR_HANDLE = 0xfffffff4 // -12
const STARTF_USESTDHANDLES = 0x100
/** ADR-088 §4: honour wShowWindow (SW_HIDE). A child that INHERITS a console (the bundled node.exe host) is
 *  unaffected; one that must create its own (an Electron host has none) gets it hidden instead of the visible
 *  window every confined command opened on the v0.1.0 VM. CREATE_NO_WINDOW is NOT the fix: it forces a new
 *  console, and a restricted-token child that has a console to inherit then dies with STATUS_DLL_INIT_FAILED
 *  (measured 2026-10-08, sandboxBackends.test.ts). */
const STARTF_USESHOWWINDOW = 0x1
const HANDLE_FLAG_INHERIT = 0x1

export function spawnUnderToken(token: unknown, commandLine: string, cwd: string): number {
	// Pass our own std handles down so the child's output reaches whatever captured OURS (the Bash tool's
	// pipe). Mark each inheritable first — inheritHandles=TRUE only duplicates handles flagged inheritable.
	// Pipes the confined child opens for ITS children (esbuild, npm scripts) are its own low-integrity objects
	// under workspace-write, so they work; under read-only they still fail (WRITE_RESTRICTED — ADR-087).
	const b = w32()
	const hIn = b.GetStdHandle(STD_INPUT_HANDLE)
	const hOut = b.GetStdHandle(STD_OUTPUT_HANDLE)
	const hErr = b.GetStdHandle(STD_ERROR_HANDLE)
	for (const h of [hIn, hOut, hErr]) b.SetHandleInformation(h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)

	const si = {
		cb: koffi.sizeof(STARTUPINFOW),
		lpReserved: null, lpDesktop: null, lpTitle: null,
		dwX: 0, dwY: 0, dwXSize: 0, dwYSize: 0, dwXCountChars: 0, dwYCountChars: 0, dwFillAttribute: 0,
		dwFlags: STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW, wShowWindow: 0 /* SW_HIDE */, cbReserved2: 0, lpReserved2: null,
		hStdInput: hIn, hStdOutput: hOut, hStdError: hErr,
	}
	const siBuf = new Uint8Array(koffi.sizeof(STARTUPINFOW))
	koffi.encode(siBuf, STARTUPINFOW, si)
	const pi = new Uint8Array(koffi.sizeof(PROCESS_INFORMATION))
	// CreateProcessW mutates lpCommandLine, so pass a writable UTF-16 buffer (NUL-terminated).
	const cmdBuf = new Uint16Array(commandLine.length + 1)
	for (let i = 0; i < commandLine.length; i++) cmdBuf[i] = commandLine.charCodeAt(i)
	checkBool(
		b.CreateProcessAsUserW(token, null, cmdBuf, null, null, 1, CREATE_UNICODE_ENVIRONMENT, null, cwd, siBuf, pi),
		'CreateProcessAsUserW',
		commandLine.slice(0, 80),
	)
	const hProcess = koffi.decode(pi, 'void*') as unknown
	const hThread = koffi.decode(pi.subarray(8), 'void*') as unknown
	b.WaitForSingleObject(hProcess, INFINITE)
	const codeOut = [0] as number[]
	checkBool(b.GetExitCodeProcess(hProcess, codeOut), 'GetExitCodeProcess')
	b.CloseHandle(hThread)
	b.CloseHandle(hProcess)
	return codeOut[0]
}
