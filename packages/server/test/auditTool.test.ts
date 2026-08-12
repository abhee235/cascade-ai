// The TemplateAudit tool gates "done" (design-overhaul P1) and had NO direct coverage until the
// 2026-08-11 qwen36-agentic-iq4 builder-shop run exposed two behaviours worth pinning: it must name
// EVERY raw-color line in a file (one-at-a-time reporting cost that run three whack-a-mole turns),
// and it must keep flagging photoFor-in-a-map, the "all six products are the same watch" bug.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
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

	it('directs the model to CALL the tool again, never to run it as a command', async () => {
		// Measured: "TemplateAudit clean" phrased as a bare name next to a backticked shell command sent a
		// 35B model hunting for `npx template-audit` for three turns.
		const out = await audit({ 'src/App.tsx': 'export const App = () => <div className="bg-red-500" />' })
		expect(out).not.toMatch(/\brun TemplateAudit\b/)
	})
})
