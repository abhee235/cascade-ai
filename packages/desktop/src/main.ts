// main.ts — the Electron shell (ADR-081 §7).
//
// Deliberately thin. It boots the EXISTING server in-process and opens a window on the built web bundle;
// any logic that lands here would not exist on web, which is the whole point of the ports work. Its real
// job is telling the server three things it cannot work out for itself once packaged:
//
//   1. where app state lives      → Electron's userData (per-OS, survives updates)
//   2. where shipped assets live  → the unpacked resources dir (bundling moved them)
//   3. when to flush and stop     → so buffered spans and replay events are not lost on quit
//
// The server is imported, not spawned. A child process would need its own Node — Electron already IS one,
// and an in-process server means one lifecycle to manage and no orphan to reap if the app is force-quit.

import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { updateElectronApp } from 'update-electron-app'

// This file is bundled to COMMONJS, unlike everything else in the repo.
//
// Electron's main process is a CJS host: `electron` and `update-electron-app` are CJS, and an ESM bundle
// reaches them only through interop that does not hold here — a named ESM import throws "does not provide
// an export named BrowserWindow", and createRequire resolves the npm shim (which exports a PATH STRING)
// instead of Electron's built-in, leaving `app` undefined. CJS output makes all of that go away. The
// SERVER stays ESM — it needs top-level await — and is reached below with a dynamic import(), which CJS
// supports.

/** Packaged: assets sit beside the app in `resources/`. Dev: they are in `dist/` next to this file. */
const RESOURCES = app.isPackaged ? join(process.resourcesPath, 'resources') : join(__dirname, 'resources')
const WEB_DIR = app.isPackaged ? join(process.resourcesPath, 'web') : join(__dirname, 'web')
const BROWSERS_DIR = app.isPackaged ? join(process.resourcesPath, 'browsers') : join(__dirname, 'browsers')

/** The server reads these at import time, so they must be set BEFORE it is loaded. */
process.env.CASCADE_APP_DATA ||= app.getPath('userData')
process.env.CASCADE_RESOURCES ||= RESOURCES
// Projects live beside the database rather than under the install directory, which on Windows is
// Program Files and not writable, and which is REPLACED wholesale by an update.
process.env.CASCADE_PROJECTS_ROOT ||= join(app.getPath('userData'), 'projects')
// Makes the server serve the built UI. Unset in dev, where Vite does it.
process.env.CASCADE_WEB_ROOT ||= WEB_DIR
// The bundled headless Chromium for the Browser tool. Only set when it was actually shipped — pointing
// Playwright at a directory that does not exist turns a working system-browser fallback into a failure.
if (existsSync(BROWSERS_DIR)) process.env.PLAYWRIGHT_BROWSERS_PATH ||= BROWSERS_DIR

const SERVER_PORT = Number(process.env.CASCADE_PORT ?? 4319)

/** Only ONE instance may own the database and the server port. A second launch focuses the first. */
if (!app.requestSingleInstanceLock()) app.exit(0)

let win: BrowserWindow | null = null
/** The server's shutdown hook, captured at boot — see disposeServer below. */
let stopServer: (() => Promise<void>) | undefined

function createWindow(): void {
	win = new BrowserWindow({
		width: 1440,
		height: 960,
		minWidth: 900,
		minHeight: 600,
		show: false, // avoid the white flash: reveal once the renderer has painted
		backgroundColor: '#0b0b0c',
		title: 'Cascade',
		// Windows/macOS take the app icon from the executable/bundle (forge packagerConfig.icon); Linux
		// window managers read it from the WINDOW. Dev runs resolve it from the source tree, packaged runs
		// would need it as an extraResource — harmless to omit there (the zip carries no desktop entry).
		...(process.platform === 'linux' ? { icon: join(__dirname, '..', 'build', 'icon.png') } : {}),
		webPreferences: {
			// The renderer is the same web app the browser serves — it talks to the server over the SAME
			// WebSocket, with no privileged bridge. Keeping Node out of it means a bug in the app (or in a
			// preview it renders) cannot reach the filesystem, and it keeps desktop and web identical.
			nodeIntegration: false,
			contextIsolation: true,
			sandbox: true,
		},
	})

	win.once('ready-to-show', () => win?.show())
	// External links open in the user's browser, not inside the app frame.
	win.webContents.setWindowOpenHandler(({ url }) => {
		void shell.openExternal(url)
		return { action: 'deny' }
	})
	// Loaded over HTTP from our own server, NOT via loadFile: a file:// page has origin "null", which the
	// WebSocket Origin check rejects and which cannot fetch /token either — the window would open and spin
	// forever. Same origin as the socket also means the desktop runs the identical code path to the browser.
	void win.loadURL(`http://127.0.0.1:${SERVER_PORT}`)
	win.on('closed', () => {
		win = null
	})
}

app.on('second-instance', () => {
	if (win) {
		if (win.isMinimized()) win.restore()
		win.focus()
	}
})

/**
 * Auto-update, via the public update.electronjs.org feed backed by GitHub Releases.
 *
 * Deliberately not a self-hosted feed: this needs no server of ours, and it only ever offers builds that
 * were actually published as releases. It is a no-op for an unpackaged or unsigned build — the library
 * refuses to update those, which is correct, since an unsigned update is an arbitrary-code-execution
 * channel rather than a feature.
 */
function startAutoUpdate(): void {
	if (!app.isPackaged) return
	try {
		updateElectronApp({ updateInterval: '6 hours', logger: { log: () => {}, info: () => {}, error: () => {}, warn: () => {} } })
	} catch {
		// A dead or unreachable feed must never stop the app from starting — the user came here to build.
	}
}

app.whenReady().then(async () => {
	await startServer()
	createWindow()
	startAutoUpdate()
	// macOS: the dock icon reopens a window rather than relaunching the app.
	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow()
	})
})

// Windows/Linux quit with the last window; macOS keeps the app alive, which is the platform convention
// and also means the server stays up for a reopen.
app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') app.quit()
})

// Flush before exiting. Spans and chat replay events are BUFFERED by design (the agent loop must never
// await telemetry), so quitting without this drops whatever the last turn produced.
app.on('before-quit', (e) => {
	if (!stopServer) return
	e.preventDefault()
	const done = stopServer
	stopServer = undefined
	void done()
		.catch(() => {})
		.finally(() => app.quit())
})

/**
 * Import the server. It self-starts (its top-level await opens the database, runs migrations, and listens),
 * which is why the environment above is set first.
 *
 * A failure here is fatal and must SAY so: the window would otherwise open, fail to reach the socket, and
 * sit on a connecting spinner forever with the real cause only in a log nobody opens.
 */
async function startServer(): Promise<void> {
	const entry = app.isPackaged ? join(process.resourcesPath, 'server.mjs') : join(__dirname, 'server.mjs')
	if (!existsSync(entry)) throw new Error(`Server bundle missing at ${entry} — run "npm run build -w @cascade/desktop".`)
	const mod = (await import(`file://${entry.replace(/\\/g, '/')}`)) as { dispose?: () => Promise<void> }
	stopServer = mod.dispose
}

export { SERVER_PORT }
