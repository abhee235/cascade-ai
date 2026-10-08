// installEvents.ts — Windows: answer Squirrel's install/update/uninstall events (ADR-091 §1).
//
// Squirrel installs silently into %LOCALAPPDATA%\cascade\ and then RUNS THE APP with one of these flags. The
// app is expected to create (or remove) its shortcuts and exit; it must not open a window or start the server.
// Before ADR-091 this was ignored, so no Start-menu or desktop shortcut ever existed and users re-ran the
// setup file — a full reinstall — just to open Cascade.

import { app } from 'electron'
import { spawn } from 'node:child_process'
import { basename, resolve } from 'node:path'

/** Squirrel's Update.exe sits one level above the versioned app dir (…\cascade\app-0.1.2\Cascade.exe). */
function runUpdateExe(args: string[]): void {
	const updateExe = resolve(process.execPath, '..', '..', 'Update.exe')
	try {
		// The 'error' listener is load-bearing: a missing Update.exe is reported as an EVENT, and an unhandled one
		// crashes the process.
		spawn(updateExe, args, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref()
	} catch {
		/* a missing Update.exe means this is not a Squirrel install — nothing to do */
	}
}

/** Handle a Squirrel event if this launch is one. Returns true when the app must quit without starting. */
export function handleSquirrelEvent(): boolean {
	if (process.platform !== 'win32') return false
	const event = process.argv[1]
	if (!event?.startsWith('--squirrel-')) return false
	const exe = basename(process.execPath) // Cascade.exe
	switch (event) {
		case '--squirrel-install':
		case '--squirrel-updated':
			// Start menu + desktop. On update this refreshes them to the new version's path.
			runUpdateExe([`--createShortcut=${exe}`])
			break
		case '--squirrel-uninstall':
			runUpdateExe([`--removeShortcut=${exe}`])
			break
		case '--squirrel-firstrun':
			return false // the first normal launch right after install: run the app
		default:
			break // --squirrel-obsolete (an old version being replaced): just exit
	}
	// Give Update.exe a moment to start before this process — its parent — goes away.
	setTimeout(() => app.quit(), 1000)
	return true
}

