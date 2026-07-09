// scripts/eval/keepAwake.mts — hold the machine awake for a long eval run. This box sleeps/hibernates at
// 60 minutes (confirmed by the user), which killed a ~90-minute builder-shop-iterate run mid-flight —
// timers and abort can't fire while suspended, so the run overran its budget by ~27 minutes on wake.
//
// Windows has no cross-process "inhibit sleep" CLI, so we spawn a PowerShell child that calls the Win32
// SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_AWAYMODE_REQUIRED). That flag holds for
// the calling thread until reset OR the thread exits — so killing the child releases the hold, no cleanup
// state to leak. No-op off Windows / if PowerShell is unavailable (best-effort: a run that sleeps is bad,
// but a runner that crashes because it couldn't spawn PowerShell is worse).

import { spawn, type ChildProcess } from 'node:child_process'

// ES_CONTINUOUS 0x80000000 (keep the state until reset) | ES_SYSTEM_REQUIRED 0x1 (no idle sleep) |
// ES_AWAYMODE_REQUIRED 0x40 (also defeat hibernate / away mode).
const PS = [
	`Add-Type -Namespace Win32 -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint e);';`,
	`[Win32.Power]::SetThreadExecutionState(0x80000000 -bor 0x1 -bor 0x40) | Out-Null;`,
	`while ($true) { Start-Sleep -Seconds 60 }`,
].join(' ')

/** Start holding the machine awake. Returns a `release()` — call it (or let the process exit) to let the
 *  machine sleep again. Idempotent-ish: release() is safe to call more than once. */
export function keepAwake(): { release: () => void } {
	if (process.platform !== 'win32') return { release: () => {} }
	let child: ChildProcess | undefined
	try {
		child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS], { stdio: 'ignore', windowsHide: true })
		child.unref() // don't keep the runner alive on account of the keep-awake child
	} catch {
		/* no PowerShell → the run proceeds unprotected rather than crashing */
	}
	// Belt-and-suspenders: if the runner dies without calling release(), still reap the child.
	const onExit = () => {
		try {
			child?.kill()
		} catch {
			/* already gone */
		}
	}
	process.once('exit', onExit)
	return {
		release: () => {
			process.removeListener('exit', onExit)
			onExit()
		},
	}
}
