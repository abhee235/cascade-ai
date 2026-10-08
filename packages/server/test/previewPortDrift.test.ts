// Preview port drift + dev-server ownership (3D Solar build, 2026-08-03).
//
// The container publishes exactly ONE port (-p 0:5173). When Vite found 5173 busy it took 5174 — published
// nowhere, so the preview was unreachable and NO url the user could type would have reached it. The pane
// showed a bare "Preview unreachable"; the model concluded "stale cache" and spent 30 minutes killing node.

import { describe, expect, it } from 'vitest'
import { parseDevPort } from '../src/previewManager'
import { devServerRefusal } from '../src/dockerSandbox'

describe('parseDevPort — read the port the dev server ACTUALLY bound', () => {
	it('reads a Vite banner, taking the LAST reported port after a restart', () => {
		const log = [
			'VITE v8.2.0  ready in 320 ms',
			'  ➜  Local:   http://localhost:5173/',
			'Port 5173 is in use, trying another one...',
			'  ➜  Local:   http://localhost:5174/',
		].join('\n')
		expect(parseDevPort(log)).toBe(5174)
	})
	it('handles 127.0.0.1 / 0.0.0.0 forms', () => {
		expect(parseDevPort('ready at http://127.0.0.1:3000/')).toBe(3000)
		expect(parseDevPort('Network: http://0.0.0.0:4321/')).toBe(4321)
	})
	it('returns undefined when the log says nothing about a port', () => {
		expect(parseDevPort('npm ERR! missing script: dev')).toBeUndefined()
		expect(parseDevPort('')).toBeUndefined()
	})
})

describe('devServerRefusal — the preview owns the dev server', () => {
	it('refuses model-started dev servers, naming what to do instead', () => {
		for (const cmd of ['npm run dev', 'npx vite', 'npx vite --host --port 5174', 'yarn dev', 'pnpm run dev', 'cd /workspace && npm start']) {
			const r = devServerRefusal(cmd)
			expect(r, cmd).toBeTruthy()
			expect(r, cmd).toContain('Preview')
		}
	})
	it('leaves builds, typechecks and tests alone', () => {
		for (const cmd of ['npm run build', 'npx vite build', 'npx tsc --noEmit', 'npm test', 'npx vite preview', 'npm install']) {
			expect(devServerRefusal(cmd), cmd).toBeUndefined()
		}
	})
})

// ADR-089 §1 — the Preview pane stops waiting the moment the launch has died, and shows the log's reason.
describe('PreviewManager — a dead launch fails fast with its cause', () => {
	it('reports the log line within seconds, not after 60', async () => {
		const { PreviewManager } = await import('../src/previewManager')
		const runtime = {
			kind: 'host',
			hasDependencies: async () => true,
			installDependencies: async () => true,
			previewPort: async () => 1, // nothing answers on port 1
			startDev: async () => {},
			stopDev: async () => {},
			devExited: () => true,
			devLog: async () => "'npm.cmd' is not recognized as an internal or external command,",
			followDevLog: () => {},
		}
		const states: { status: string; error?: string }[] = []
		const t0 = Date.now()
		await new PreviewManager().start('p1', runtime as never, (st) => states.push(st))
		expect(Date.now() - t0).toBeLessThan(5_000)
		expect(states.at(-1)?.status).toBe('error')
		expect(states.at(-1)?.error).toContain("'npm.cmd' is not recognized")
	}, 15_000)
})
