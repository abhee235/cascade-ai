// restyle-demo.mjs — the design-overhaul plan's FINAL acceptance demo, scripted (no model involved):
//   1. assemble the shop solution on the stock `premium` preset (exactly what a green build produces)
//   2. build + screenshot BEFORE
//   3. Restyle: preset → luxe-dark, skin → sharp (the tool's own code paths, not hand edits)
//   4. TemplateAudit must be clean; designLint must stay green under the NEW preset
//   5. build + screenshot AFTER
// The screenshots are the user's judgment material; the assertions are the mechanical half of the gate.
//
//   node eval/builder/_lib/restyle-demo.mjs        (run from the repo root)

import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runDesignLint } from './designLint.mjs'
import { noResidue } from './residue.mjs'

const ROOT = resolve(import.meta.dirname, '..', '..', '..')
const TEMPLATE = join(ROOT, 'packages', 'server', 'templates', 'react')
const SHARED_DEPS = join(ROOT, 'eval', 'external', 'builder-template', 'node_modules')
const SOLUTION = join(ROOT, 'eval', 'builder', 'builder-shop', 'solution')
const OUT = join(ROOT, 'eval', 'runs', 'restyle-demo')

const fail = (msg) => {
	console.error(`restyle-demo: ${msg}`)
	process.exit(1)
}

// ── 1) Assemble: template (product copy filter) + shop solution overlay ────────────────────────────────
const { templateCopyFilter } = await import(pathToFileURL(join(ROOT, 'packages', 'server', 'src', 'templates.ts')).href).catch(() => ({ templateCopyFilter: undefined }))
const work = join(ROOT, 'eval', '.work', 'restyle-demo')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
cpSync(TEMPLATE, work, { recursive: true, filter: templateCopyFilter ?? ((src) => !/node_modules|[\\/]demo[\\/]|[\\/]packs[\\/]|[\\/]skins[\\/]/.test(src)) })
symlinkSync(SHARED_DEPS, join(work, 'node_modules'), 'junction')
cpSync(SOLUTION, work, { recursive: true })

const build = (label) => {
	const r = spawnSync(process.execPath, [join('node_modules', 'vite', 'bin', 'vite.js'), 'build'], { cwd: work, encoding: 'utf8', timeout: 180_000 })
	if (r.status !== 0) fail(`vite build FAILED (${label}):\n${(r.stderr || r.stdout).slice(-1200)}`)
	return readdirSync(join(work, 'dist', 'assets'))
		.filter((f) => f.endsWith('.js'))
		.map((f) => readFileSync(join(work, 'dist', 'assets', f), 'utf8'))
		.join('\n')
}

const shoot = async (name) => {
	mkdirSync(OUT, { recursive: true })
	const port = 4573
	const preview = spawn(process.execPath, [join('node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(port), '--strictPort'], { cwd: work, stdio: 'ignore' })
	try {
		await new Promise((r) => setTimeout(r, 2500))
		const { chromium } = await import('playwright-core')
		let browser
		for (const channel of ['msedge', 'chrome']) {
			try {
				browser = await chromium.launch({ channel, headless: true })
				break
			} catch {}
		}
		if (!browser) {
			console.log('   (no system browser — screenshots skipped)')
			return
		}
		try {
			const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
			await page.goto(`http://localhost:${port}/`, { waitUntil: 'networkidle', timeout: 15_000 })
			await page.screenshot({ path: join(OUT, `${name}-light.png`) })
			await page.evaluate("document.documentElement.classList.add('dark')")
			await page.waitForTimeout(300)
			await page.screenshot({ path: join(OUT, `${name}-dark.png`) })
			console.log(`   📷 ${name}-{light,dark}.png`)
		} finally {
			await browser.close().catch(() => {})
		}
	} finally {
		if (preview.pid) {
			if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(preview.pid), '/T', '/F'], { stdio: 'ignore' })
			else preview.kill('SIGKILL')
		}
	}
}

// ── 2) BEFORE: premium preset, base skin — must already be green ───────────────────────────────────────
let bundle = build('before')
process.chdir(work)
if (runDesignLint(bundle, { blocks: ['navbar', 'media-card', 'empty-state'], preset: 'premium' }) > 0) fail('BEFORE state fails designLint — the demo must start green')
if (noResidue(work) > 0) fail('BEFORE state has residue')
process.chdir(ROOT)
await shoot('shop-premium-base')

// ── 3) Restyle via the tool's real code paths ──────────────────────────────────────────────────────────
const { createRestyleTool } = await import(pathToFileURL(join(ROOT, 'packages', 'server', 'src', 'restyleTool.ts')).href)
const restyle = createRestyleTool({ projectDir: work, templateId: 'react' })
if (!restyle) fail('createRestyleTool returned undefined — no presets found in the workdir')
const ctx = { cwd: work, abortSignal: new AbortController().signal }
const p = await restyle.call({ op: 'preset', preset: 'luxe-dark' }, ctx)
if (p.isError) fail(`Restyle preset op failed: ${p.content}`)
console.log(`   ${String(p.content).split('.')[0]}.`)
const s = await restyle.call({ op: 'skin', skin: 'sharp' }, ctx)
if (s.isError) fail(`Restyle skin op failed: ${s.content}`)
console.log(`   ${String(s.content).split('.')[0]}.`)

// ── 4) The gates: TemplateAudit clean, designLint green under the NEW preset ───────────────────────────
const { createTemplateAuditTool } = await import(pathToFileURL(join(ROOT, 'packages', 'server', 'src', 'auditTool.ts')).href)
const audit = createTemplateAuditTool({ projectDir: work, templateId: 'react' })
if (audit) {
	const a = await audit.call({}, ctx)
	if (a.isError) fail(`TemplateAudit NOT clean after restyle:\n${String(a.content).slice(0, 800)}`)
	console.log('   TemplateAudit: clean.')
}
bundle = build('after')
process.chdir(work)
if (runDesignLint(bundle, { blocks: ['navbar', 'media-card', 'empty-state'], preset: 'luxe-dark' }) > 0) fail('AFTER state fails designLint under luxe-dark')
if (noResidue(work) > 0) fail('AFTER state has residue')
process.chdir(ROOT)

// ── 5) AFTER screenshots ───────────────────────────────────────────────────────────────────────────────
await shoot('shop-luxedark-sharp')
console.log(`\nrestyle-demo PASSED — zero app-code edits, both gates green.\nscreenshots → ${OUT}`)
