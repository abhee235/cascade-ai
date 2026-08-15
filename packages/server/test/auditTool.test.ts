// The TemplateAudit tool gates "done" (design-overhaul P1) and had NO direct coverage until the
// 2026-08-11 qwen36-agentic-iq4 builder-shop run exposed two behaviours worth pinning: it must name
// EVERY raw-color line in a file (one-at-a-time reporting cost that run three whack-a-mole turns),
// and it must keep flagging photoFor-in-a-map, the "all six products are the same watch" bug.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTemplateAuditTool } from '../src/auditTool.js'

const dirs: string[] = []
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A throwaway project holding exactly the src files a case needs. */
function project(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), 'cascade-audit-'))
	dirs.push(dir)
	for (const [rel, text] of Object.entries(files)) {
		const abs = join(dir, rel)
		mkdirSync(join(abs, '..'), { recursive: true })
		writeFileSync(abs, text)
	}
	return dir
}

async function audit(files: Record<string, string>): Promise<string> {
	const tool = createTemplateAuditTool({ projectDir: project(files), templateId: 'react' })
	expect(tool, 'the react template must ship a residue contract').toBeTruthy()
	const res = await tool!.call({} as never, {} as never)
	return typeof res.content === 'string' ? res.content : JSON.stringify(res.content)
}

describe('TemplateAudit — style pre-flights', () => {
	it('names EVERY raw-color line in one finding, not just the first', async () => {
		const out = await audit({
			'src/CheckoutView.tsx': [
				"import { Section } from '@/components/blocks/Section'", // block import present ⇒ no hand-rolled finding
				'export function CheckoutView() {',
				'\treturn (',
				'\t\t<Section>',
				'\t\t\t<div className="bg-green-100" />',
				'\t\t\t<p className="text-slate-500">hi</p>',
				'\t\t</Section>',
				'\t)',
				'}',
			].join('\n'),
		})
		// One line per finding — so a single line mentioning both numbers is the whole point.
		const line = out.split('\n').find((l) => l.includes('raw color'))
		expect(line, out).toBeTruthy()
		expect(line).toContain('5')
		expect(line).toContain('6')
		expect(line).toMatch(/2 lines/)
		expect(out.split('\n').filter((l) => l.includes('raw color'))).toHaveLength(1)
	})

	it('token-only styling produces no raw-color finding', async () => {
		const out = await audit({
			'src/Clean.tsx': ["import { Section } from '@/components/blocks/Section'", 'export const Clean = () => <Section className="bg-primary text-muted-foreground" />'].join('\n'),
		})
		expect(out).not.toContain('raw color')
	})

	it('flags photoFor() inside a list render', async () => {
		const out = await audit({
			'src/CatalogView.tsx': [
				"import { photoFor } from '@/lib/photos'",
				"import { MediaCard } from '@/components/blocks/MediaCard'",
				'export const CatalogView = ({ products }) => products.map((p) => (',
				'\t<MediaCard key={p.id} media={<img src={photoFor(p.photoKey, "product")} />} />',
				'))',
			].join('\n'),
		})
		expect(out).toContain('photoFor inside a list render')
	})

	it('flags a page with zero block imports as hand-rolled', async () => {
		const out = await audit({ 'src/App.tsx': 'export const App = () => <div className="p-4">hi</div>' })
		expect(out).toContain('no @/components/blocks imports')
	})

	it('flags a hand-written photo() that shadows the house helper', async () => {
		// Measured (qwen3.5:9b, builder-landing 2026-08-15): the model wrote its own `function photo(name:
		// string)` returning `/photos/<name>.webp` and never imported @/lib/photos. Every signal said fine —
		// its local helper takes `string` so tsc passed, the real module went unused so no photo was bundled —
		// and the page shipped a broken <img>. src/lib cannot be frozen (it is the model's own space), so the
		// shadow is caught by name.
		const shadowed = await audit({
			'src/components/Home.tsx': ['function photo(name: string): string {', "\treturn `/photos/${name}.webp`", '}', 'export const Home = () => <img src={photo("hero")} />'].join('\n'),
		})
		expect(shadowed).toContain('re-defines `photo()`')

		// Importing the real one is the correct shape and must stay silent.
		const correct = await audit({
			'src/components/Home.tsx': ["import { photo } from '@/lib/photos'", 'export const Home = () => <img src={photo("workspace-code")} />'].join('\n'),
		})
		expect(correct).not.toContain('re-defines')

		// And the module that legitimately DEFINES them is never flagged for doing its job — this fired
		// against the real project before it was excluded.
		const lib = await audit({ 'src/lib/photos.ts': 'export function photo(name: string) { return name }\nexport function photoFor(seed: string) { return seed }' })
		expect(lib).not.toContain('re-defines')
	})

	it('flags a <Hero> with no media — but never asks a page without one for a picture', async () => {
		// Measured (qwen3.5:9b, builder-landing 2026-08-15): nine blocks composed into a real landing page,
		// `media` passed to none of them — a page with no image anywhere, and the run's only remaining failure.
		const noMedia = await audit({
			'src/components/Landing.tsx': ["import { Hero } from '@/components/blocks/Hero'", 'export const Landing = () => <Hero headline="Ship faster" subcopy="Really." />'].join('\n'),
		})
		expect(noMedia).toContain('no `media`')

		const withMedia = await audit({
			'src/components/Landing.tsx': [
				"import { Hero } from '@/components/blocks/Hero'",
				"import { photo } from '@/lib/photos'",
				'export const Landing = () => <Hero headline="Ship faster" media={<img src={photo("workspace-code")} alt="app" />} />',
			].join('\n'),
		})
		expect(withMedia).not.toContain('no `media`')

		// A dashboard mounts no Hero, so it is never asked for a photograph it has no use for.
		const dashboard = await audit({
			'src/components/Overview.tsx': ["import { StatCard } from '@/components/blocks/StatCard'", 'export const Overview = () => <StatCard label="Runs" value="12" />'].join('\n'),
		})
		expect(dashboard).not.toContain('no `media`')
	})

	it('flags an EDITED shared block as HARD residue', async () => {
		// Measured (qwen3.5:9b 2026-08-13): two of three builds rewrote src/components/blocks — NavBar,
		// Hero, LogoStrip — while the build stayed green. The session's frozenPaths guard is the primary
		// defence; this is the backstop for projects it cannot reach (resumed builds, hand-edits).
		const out = await audit({
			'src/components/blocks/Hero.tsx': 'export function Hero() { return <div>my own version</div> }',
			'src/App.tsx': "import { Hero } from '@/components/blocks/Hero'\nexport const App = () => <Hero />",
		})
		expect(out).toContain('src/components/blocks/Hero.tsx')
		expect(out).toMatch(/EDITED/)
		expect(out).toContain('HARD') // blocks the done-ladder; not a suggestion
	})

	it('flags an INVENTED block — a new file in the shared layer breaks the same contract', async () => {
		const out = await audit({ 'src/components/blocks/DangerZone.tsx': 'export const DangerZone = () => null' })
		expect(out).toContain('DangerZone.tsx')
		expect(out).toMatch(/NEW file/)
	})

	it('says nothing about a block the project left alone', async () => {
		// The pristine template copy is ground truth; an untouched block must never be flagged.
		const pristine = readFileSync(join(import.meta.dirname, '..', 'templates', 'react', 'src', 'components', 'blocks', 'Hero.tsx'), 'utf8')
		const out = await audit({ 'src/components/blocks/Hero.tsx': pristine, 'src/App.tsx': 'export const App = () => null' })
		expect(out).not.toContain('blocks/Hero.tsx')
	})

	it('directs the model to CALL the tool again, never to run it as a command', async () => {
		// Measured: "TemplateAudit clean" phrased as a bare name next to a backticked shell command sent a
		// 35B model hunting for `npx template-audit` for three turns.
		const out = await audit({ 'src/App.tsx': 'export const App = () => <div className="bg-red-500" />' })
		expect(out).not.toMatch(/\brun TemplateAudit\b/)
	})
})
