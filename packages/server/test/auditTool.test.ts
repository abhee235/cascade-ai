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

	it('no longer calls a page without block imports hand-rolled — adapting a pattern is the point (ADR-086 P1)', async () => {
		const out = await audit({ 'src/App.tsx': 'export const App = () => <div className="p-4">hi</div>' })
		expect(out).not.toContain('block imports')
	})

	it('does not call an ordinary word residue without corroborating demo evidence', async () => {
		// Measured (qwen36-agentic-iq4, builder-shop 2026-08-15): a shop named a product "Meridian Watch" —
		// a plausible name for a watch — and the audit reported it twice as "the demo brand … replace with
		// the app's own brand name". The model fixed everything else and left this, because the instruction
		// does not parse: its brand WAS "Cascade Shop"; Meridian was a product. And since the demo stopped
		// being copied into projects, a fresh project cannot inherit that word at all.
		const invented = await audit({ 'src/lib/data.ts': "export const PRODUCTS = [{ id: 'p1', name: 'Meridian Watch', price: 189 }]" })
		expect(invented).not.toContain('Meridian')

		// …but a project that really did carry the demo still gets told: the import is the corroboration.
		const legacy = await audit({
			'src/lib/data.ts': "export const PRODUCTS = [{ id: 'p1', name: 'Meridian Watch', price: 189 }]",
			'src/App.tsx': "import { Gallery } from '@/demo/Gallery'\nexport const App = () => <Gallery />",
		})
		expect(legacy).toContain('Meridian')
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

	it('an edited or added block is the app\'s own code now — never residue (ADR-086 P1, the open template)', async () => {
		const out = await audit({
			'src/components/blocks/Hero.tsx': 'export function Hero() { return <section className="bg-primary">my own version</section> }',
			'src/components/blocks/DangerZone.tsx': 'export const DangerZone = () => null',
			'src/App.tsx': "import { Hero } from '@/components/blocks/Hero'\nexport const App = () => <Hero />",
		})
		expect(out).not.toMatch(/EDITED|NEW file|read-only/)
		expect(out).not.toMatch(/HARD residue \(/) // no HARD section at all
	})

	it('reads an EDITED kit file for raw colors, and leaves an untouched one alone', async () => {
		// What an edit ADDS is still judged; the shipped kit is template code, not the model's styling.
		const pristine = readFileSync(join(import.meta.dirname, '..', 'templates', 'react', 'src', 'components', 'ui', 'button.tsx'), 'utf8')
		expect(await audit({ 'src/components/ui/button.tsx': pristine })).not.toContain('ui/button.tsx')
		const edited = await audit({ 'src/components/ui/button.tsx': `${pristine}\nexport const Danger = () => <b className="text-red-600" />` })
		expect(edited).toContain('ui/button.tsx')
		expect(edited).toContain('raw color')
	})

	it('directs the model to CALL the tool again, never to run it as a command', async () => {
		// Measured: "TemplateAudit clean" phrased as a bare name next to a backticked shell command sent a
		// 35B model hunting for `npx template-audit` for three turns.
		const out = await audit({ 'src/App.tsx': 'export const App = () => <div className="bg-red-500" />' })
		expect(out).not.toMatch(/\brun TemplateAudit\b/)
	})
})
