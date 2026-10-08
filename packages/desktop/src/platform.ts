// platform.ts — first-run integration that makes the unzipped app behave installed (ADR-091 §4–5).
//
//   macOS: offer to move Cascade.app into /Applications (the zip leaves it in Downloads, where auto-update
//          cannot replace it). Asked once; "Not now" is remembered.
//   Linux: write ~/.local/share/applications/cascade.desktop so Cascade appears in the app menu, pointing at
//          the binary that is running NOW — rewritten when the folder moved, left alone when it is current.

import { app, dialog } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const declinedFlag = () => join(app.getPath('userData'), 'move-to-applications-declined')

/** macOS only, packaged only. Returns true when the app is relaunching from /Applications (caller stops). */
export function offerMoveToApplications(): boolean {
	if (process.platform !== 'darwin' || !app.isPackaged || app.isInApplicationsFolder()) return false
	if (existsSync(declinedFlag())) return false
	const choice = dialog.showMessageBoxSync({
		type: 'question',
		buttons: ['Move to Applications', 'Not now'],
		defaultId: 0,
		cancelId: 1,
		message: 'Move Cascade to your Applications folder?',
		detail: 'Cascade is running from a temporary place, like Downloads. In Applications it stays put, shows in Launchpad, and can update itself.',
	})
	if (choice !== 0) {
		try {
			writeFileSync(declinedFlag(), '')
		} catch {
			/* asking again next launch is the only cost */
		}
		return false
	}
	try {
		return app.moveToApplicationsFolder() // quits and relaunches from /Applications on success
	} catch {
		return false // e.g. a copy is already there and running — carry on from here
	}
}

/** Linux only, packaged only: keep an app-menu entry pointing at this binary and the shipped icon. */
export function ensureDesktopEntry(): void {
	if (process.platform !== 'linux' || !app.isPackaged) return
	const dir = join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'applications')
	const file = join(dir, 'cascade.desktop')
	const exec = process.env.APPIMAGE || process.execPath
	const entry = [
		'[Desktop Entry]',
		'Type=Application',
		'Name=Cascade',
		'Comment=Local-first AI app builder',
		`Exec="${exec}" %U`,
		`Icon=${linuxIconPath()}`,
		'Terminal=false',
		'Categories=Development;IDE;',
		'StartupWMClass=Cascade',
		'',
	].join('\n')
	try {
		if (existsSync(file) && readFileSync(file, 'utf8') === entry) return
		mkdirSync(dir, { recursive: true })
		writeFileSync(file, entry, { mode: 0o644 })
	} catch {
		/* a read-only home or sandboxed session loses the menu entry, not the app */
	}
}

/** The PNG icon shipped beside the app (forge extraResource) — the window icon and the menu entry use it. */
export function linuxIconPath(): string {
	return app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(__dirname, '..', 'build', 'icon.png')
}
