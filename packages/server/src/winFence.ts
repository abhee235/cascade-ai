// winFence.ts — the Win32 FFI core of the Windows write-fence (ADR-070 step 6). Runs in the RUNNER
// process (winFenceRunner.ts), never in the server. koffi binds the handful of advapi32/kernel32 calls
// the mechanism needs.
//
// Mechanism: duplicate the caller's token into a WRITE_RESTRICTED restricted token whose restricting-SID
// list carries the keep-alive pair (logon SID + Everyone) plus, under workspace-write, the synthetic
// workspace + temp SIDs. Windows then checks every WRITE twice — the object's own DACL AND the restricting
// list — so a write clears only where BOTH allow it. Reads/exec/network are untouched (that is exactly why
// arbitrary toolchains keep working, and exactly why this is `partial`, not full, enforcement: reads and
// network are open, and the documented Everyone/hard-link boundaries remain). Then grant a write ACE for
// the workspace SID on the workspace tree, merge that SID into the token's default DACL (so child-created
// objects like anonymous pipes pass the pass-2 check), and CreateProcessAsUser the child under the token.
//
// EVERY Win32 call is checked and throws Win32Error on failure — fail-closed by construction. The public
// POC this mechanism follows ignored return values and, when token creation failed, silently ran the child
// with the FULL unrestricted token; this port never does.

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
const TokenDefaultDacl = 6
const ERROR_INSUFFICIENT_BUFFER = 122
const ERROR_SUCCESS = 0
const SE_FILE_OBJECT = 1
const DACL_SECURITY_INFORMATION = 0x4
const GRANT_ACCESS = 1
const SUB_CONTAINERS_AND_OBJECTS_INHERIT = 0x3
const NO_MULTIPLE_TRUSTEE = 0
const TRUSTEE_IS_SID = 0
const TRUSTEE_IS_UNKNOWN = 0
const FILE_GENERIC_WRITE = 0x120116
const CREATE_UNICODE_ENVIRONMENT = 0x00000400
const INFINITE = 0xffffffff
const SECURITY_MAX_SID_SIZE = 68
const WinWorldSid = 1 // Everyone

// ── struct layouts ──────────────────────────────────────────────────────────────────────────────────
// SID_AND_ATTRIBUTES { PSID Sid; DWORD Attributes; } — 8-byte pointer + 4-byte dword, 8-byte aligned = 16.
const SID_AND_ATTRIBUTES = koffi.struct('SID_AND_ATTRIBUTES', { Sid: 'void*', Attributes: 'uint32' })
// TRUSTEE_W { TRUSTEE_W* MultipleTrustee; int MultipleTrusteeOperation; int TrusteeForm; int TrusteeType; void* ptstrName; }
const TRUSTEE_W = koffi.struct('TRUSTEE_W', {
	pMultipleTrustee: 'void*',
	MultipleTrusteeOperation: 'int',
	TrusteeForm: 'int',
	TrusteeType: 'int',
	ptstrName: 'void*',
})
// EXPLICIT_ACCESS_W { DWORD grfAccessPermissions; int grfAccessMode; DWORD grfInheritance; TRUSTEE_W Trustee; }
const EXPLICIT_ACCESS_W = koffi.struct('EXPLICIT_ACCESS_W', {
	grfAccessPermissions: 'uint32',
	grfAccessMode: 'int',
	grfInheritance: 'uint32',
	Trustee: TRUSTEE_W,
})
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
		SetEntriesInAclW: advapi32.func('uint32 SetEntriesInAclW(uint32 count, void* entries, void* oldAcl, _Out_ void** newAcl)'),
		SetNamedSecurityInfoW: advapi32.func('uint32 SetNamedSecurityInfoW(str16 name, int objType, uint32 secInfo, void* owner, void* group, void* dacl, void* sacl)'),
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
	/** Writable roots to grant + their SIDs (workspace-write only). Each: an existing directory + its SID. */
	grants?: { dir: string; sid: string }[]
}

/**
 * Build a WRITE_RESTRICTED token for `mode`, grant write ACEs for each `grants` entry, and return the token
 * handle plus a pointer array to keep the SID buffers alive for the token's lifetime. Fail-closed: any
 * Win32 failure throws before a child is ever spawned.
 */
export function buildRestrictedToken(opts: FenceOptions): { token: unknown; keepAlive: unknown[] } {
	const procTokenOut = [null] as unknown[]
	checkBool(
		w32().OpenProcessToken(w32().GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT, procTokenOut),
		'OpenProcessToken',
	)
	const procToken = procTokenOut[0]

	// Restricting list: keep-alive pair in both modes; the capability SIDs only under workspace-write.
	const keepAlive: unknown[] = []
	const sids: unknown[] = [logonSid(procToken), everyoneSid()]
	if (opts.mode === 'workspace-write') {
		for (const g of opts.grants ?? []) {
			const sid = sidFromString(g.sid)
			keepAlive.push(sid)
			sids.push(sid)
		}
	}
	// Pack SID_AND_ATTRIBUTES[]: one 16-byte entry per SID, Attributes = 0.
	const arr = new Uint8Array(sids.length * 16)
	for (let i = 0; i < sids.length; i++) koffi.encode(arr.subarray(i * 16), 'void*', sids[i])
	keepAlive.push(...sids, arr)

	const tokenOut = [null] as unknown[]
	checkBool(
		w32().CreateRestrictedToken(procToken, DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED, 0, null, 0, null, sids.length, arr, tokenOut),
		'CreateRestrictedToken',
		`${sids.length} restricting SIDs`,
	)
	const token = tokenOut[0]

	// Merge each capability SID into the token's DEFAULT DACL so the child's own new objects (anonymous
	// stdio pipes) pass the write pass-2 check. The directory-side write ACEs are NOT granted here — the
	// server grants them ONCE per workspace (grantWriteAce, cached), because that grant is a standing,
	// expensive full-tree propagation and must not repeat on every exec.
	if (opts.mode === 'workspace-write') {
		for (const g of opts.grants ?? []) mergeDefaultDaclSid(token, g.sid)
	}
	w32().CloseHandle(procToken)
	return { token, keepAlive }
}

/** Add an inheritable FILE_GENERIC_WRITE allow ACE for `sddlSid` on `dir` (merged with the existing DACL).
 *  Idempotent at the OS level — re-adding the identical ACE is a no-op cost aside, which is why the same
 *  workspace SID's grant can STAND across sessions. */
export function grantWriteAce(dir: string, sddlSid: string): void {
	const sid = sidFromString(sddlSid)
	// EXPLICIT_ACCESS_W describing the grant.
	const ea = {
		grfAccessPermissions: FILE_GENERIC_WRITE,
		grfAccessMode: GRANT_ACCESS,
		grfInheritance: SUB_CONTAINERS_AND_OBJECTS_INHERIT,
		Trustee: { pMultipleTrustee: null, MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE, TrusteeForm: TRUSTEE_IS_SID, TrusteeType: TRUSTEE_IS_UNKNOWN, ptstrName: sid },
	}
	const eaBuf = new Uint8Array(koffi.sizeof(EXPLICIT_ACCESS_W))
	koffi.encode(eaBuf, EXPLICIT_ACCESS_W, ea)
	const newAclOut = [null] as unknown[]
	// oldAcl = null merges into a fresh ACL carrying only this ACE; SetNamedSecurityInfo then UNIONs it
	// with the object's existing DACL because we pass DACL_SECURITY_INFORMATION without PROTECTED — the
	// standard "add an ACE" idiom.
	const r1 = w32().SetEntriesInAclW(1, eaBuf, null, newAclOut)
	if (r1 !== ERROR_SUCCESS) throw new Win32Error('SetEntriesInAclW', r1, dir)
	const newAcl = newAclOut[0]
	const r2 = w32().SetNamedSecurityInfoW(dir, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, null, null, newAcl, null)
	w32().LocalFree(newAcl)
	if (r2 !== ERROR_SUCCESS) throw new Win32Error('SetNamedSecurityInfoW', r2, dir)
}

/** Merge a full-access ACE for `sddlSid` into the token's DEFAULT DACL (the DACL new objects the token
 *  creates inherit). Without it, a child's anonymous stdio pipe fails its own creation-time write check —
 *  every piped grandchild spawn breaks (the POC-documented boundary). Named a RESTRICTING sid, so the new
 *  object passes pass-2 while creation stays gated by the parent container's DACL. */
function mergeDefaultDaclSid(token: unknown, sddlSid: string): void {
	const retLen = [0] as number[]
	w32().GetTokenInformation(token, TokenDefaultDacl, null, 0, retLen)
	const needed = retLen[0]
	if (needed === 0) throw new Win32Error('GetTokenInformation', w32().GetLastError(), 'TokenDefaultDacl size')
	const buf = new Uint8Array(needed)
	checkBool(w32().GetTokenInformation(token, TokenDefaultDacl, buf, needed, retLen), 'GetTokenInformation', 'TokenDefaultDacl')
	// TOKEN_DEFAULT_DACL { PACL DefaultDacl; } — the current DACL pointer sits at offset 0.
	const currentDacl = koffi.decode(buf, 'void*') as unknown
	const sid = sidFromString(sddlSid)
	const ea = {
		grfAccessPermissions: 0x10000000, // GENERIC_ALL — full access for the token's own new objects
		grfAccessMode: GRANT_ACCESS,
		grfInheritance: 0,
		Trustee: { pMultipleTrustee: null, MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE, TrusteeForm: TRUSTEE_IS_SID, TrusteeType: TRUSTEE_IS_UNKNOWN, ptstrName: sid },
	}
	const eaBuf = new Uint8Array(koffi.sizeof(EXPLICIT_ACCESS_W))
	koffi.encode(eaBuf, EXPLICIT_ACCESS_W, ea)
	const newAclOut = [null] as unknown[]
	const r = w32().SetEntriesInAclW(1, eaBuf, currentDacl, newAclOut)
	if (r !== ERROR_SUCCESS) throw new Win32Error('SetEntriesInAclW', r, 'default DACL merge')
	const newDacl = newAclOut[0]
	// SetTokenInformation copies the ACL, so we free ours right after.
	const info = new Uint8Array(8)
	koffi.encode(info, 'void*', newDacl)
	const ok = w32().SetTokenInformation(token, TokenDefaultDacl, info, 8)
	w32().LocalFree(newDacl)
	checkBool(ok, 'SetTokenInformation', 'TokenDefaultDacl')
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
const HANDLE_FLAG_INHERIT = 0x1

export function spawnUnderToken(token: unknown, commandLine: string, cwd: string): number {
	// Pass our own std handles down so the child's output reaches whatever captured OURS (the Bash tool's
	// pipe). Mark each inheritable first — inheritHandles=TRUE only duplicates handles flagged inheritable.
	// This works for the DIRECT child; a confined child that opens its OWN pipes for a grandchild is the
	// documented `partial` boundary (named-pipe default SD), which we do not need here.
	const b = w32()
	const hIn = b.GetStdHandle(STD_INPUT_HANDLE)
	const hOut = b.GetStdHandle(STD_OUTPUT_HANDLE)
	const hErr = b.GetStdHandle(STD_ERROR_HANDLE)
	for (const h of [hIn, hOut, hErr]) b.SetHandleInformation(h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)

	const si = {
		cb: koffi.sizeof(STARTUPINFOW),
		lpReserved: null, lpDesktop: null, lpTitle: null,
		dwX: 0, dwY: 0, dwXSize: 0, dwYSize: 0, dwXCountChars: 0, dwYCountChars: 0, dwFillAttribute: 0,
		dwFlags: STARTF_USESTDHANDLES, wShowWindow: 0, cbReserved2: 0, lpReserved2: null,
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
