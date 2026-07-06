// scripts/gen/genKitReference.mts — generate the design skill's component reference FROM THE ACTUAL KIT
// SOURCE (ADR-055 reference pattern; user requirement: "refer to the codebase for designing frontends,
// the written skills look vague"). Extracts every export and every cva variant/size option from
// src/components/ui/*.tsx, so the reference is exact and regenerates when the kit changes.
//
//   npx tsx scripts/gen/genKitReference.mts   (run after any kit change; commit the output)

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..')
const UI = join(ROOT, 'packages', 'server', 'templates', 'react', 'src', 'components', 'ui')
const OUT_DIR = join(ROOT, 'packages', 'server', 'skills', 'builder', 'design', 'reference')

/** Hand-written composition examples for the workhorses (generated facts + curated usage = precise AND practical). */
const EXAMPLES: Record<string, string> = {
	button: `\`\`\`tsx
<Button onClick={save}>Save</Button>
<Button variant="secondary">Cancel</Button>
<Button variant="destructive" size="sm">Delete</Button>
<Button variant="outline" size="icon"><Trash2 /></Button>  // lucide icon button
\`\`\``,
	card: `\`\`\`tsx
<Card>
  <CardHeader>
    <CardTitle>Revenue</CardTitle>
    <CardDescription>Last 30 days</CardDescription>
  </CardHeader>
  <CardContent>…</CardContent>
  <CardFooter className="justify-end"><Button>Details</Button></CardFooter>
</Card>
\`\`\``,
	dialog: `\`\`\`tsx
<Dialog open={open} onOpenChange={setOpen}>
  <DialogTrigger asChild><Button>Edit</Button></DialogTrigger>
  <DialogContent>
    <DialogHeader><DialogTitle>Edit item</DialogTitle><DialogDescription>Changes save on submit.</DialogDescription></DialogHeader>
    {/* form fields */}
    <DialogFooter><Button type="submit">Save</Button></DialogFooter>
  </DialogContent>
</Dialog>
\`\`\``,
	select: `\`\`\`tsx
<Select value={cat} onValueChange={setCat}>
  <SelectTrigger className="w-44"><SelectValue placeholder="Category" /></SelectTrigger>
  <SelectContent>{cats.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
</Select>
\`\`\``,
	tabs: `\`\`\`tsx
<Tabs defaultValue="overview">
  <TabsList><TabsTrigger value="overview">Overview</TabsTrigger><TabsTrigger value="settings">Settings</TabsTrigger></TabsList>
  <TabsContent value="overview">…</TabsContent>
  <TabsContent value="settings">…</TabsContent>
</Tabs>
\`\`\``,
	table: `\`\`\`tsx
<Table>
  <TableHeader><TableRow><TableHead>Name</TableHead><TableHead className="text-right">Price</TableHead></TableRow></TableHeader>
  <TableBody>{rows.map(r => (
    <TableRow key={r.id}><TableCell>{r.name}</TableCell><TableCell className="text-right">\${r.price.toFixed(2)}</TableCell></TableRow>
  ))}</TableBody>
</Table>
\`\`\``,
	'dropdown-menu': `\`\`\`tsx
<DropdownMenu>
  <DropdownMenuTrigger asChild><Button variant="ghost" size="icon">⋯</Button></DropdownMenuTrigger>
  <DropdownMenuContent align="end">
    <DropdownMenuItem onClick={edit}>Edit</DropdownMenuItem>
    <DropdownMenuSeparator />
    <DropdownMenuItem variant="destructive" onClick={remove}>Delete</DropdownMenuItem>
  </DropdownMenuContent>
</DropdownMenu>
\`\`\``,
}

/** Pull `variants: { key: { option: …, option: … } }` out of a cva() call with a brace WALKER (formatting-
 *  independent). Keys at depth 1 are variant axes; keys at depth 2 are their options. */
function extractVariants(src: string): Record<string, string[]> {
	const out: Record<string, string[]> = {}
	const start = src.indexOf('variants:')
	if (start === -1) return out
	const open = src.indexOf('{', start)
	if (open === -1) return out
	let depth = 0
	let axis = ''
	let inString: string | null = null
	for (let i = open; i < src.length; i++) {
		const ch = src[i]!
		if (inString) {
			if (ch === inString && src[i - 1] !== '\\') inString = null
			continue
		}
		if (ch === '"' || ch === "'" || ch === '`') {
			inString = ch
			continue
		}
		if (ch === '{') depth++
		else if (ch === '}') {
			depth--
			if (depth === 0) break // end of the variants block
		} else if (/[\w-]/.test(ch)) {
			// Read an identifier; if followed by ':', it's a key at the current depth.
			let j = i
			while (j < src.length && /[\w-]/.test(src[j]!)) j++
			const word = src.slice(i, j)
			const rest = src.slice(j).match(/^\s*:/)
			if (rest) {
				if (depth === 1) {
					axis = word
					out[axis] = []
				} else if (depth === 2 && axis) {
					out[axis]!.push(word)
				}
			}
			i = j - 1
		}
	}
	for (const k of Object.keys(out)) if (out[k]!.length === 0) delete out[k]
	return out
}

const files = readdirSync(UI).filter((f) => f.endsWith('.tsx')).sort()
const sections: string[] = []
const toc: string[] = []

for (const f of files) {
	const src = readFileSync(join(UI, f), 'utf8')
	const comp = basename(f, '.tsx')
	const exports = [...src.matchAll(/export \{([\s\S]*?)\}/g)].flatMap((m) => m[1]!.split(',').map((s) => s.trim()).filter((s) => s && !s.startsWith('type ')))
	const variants = extractVariants(src)
	toc.push(`- ${comp}`)
	const lines = [`## ${comp}`, '', `Import: \`import { ${exports.slice(0, 4).join(', ')}${exports.length > 4 ? ', …' : ''} } from '@/components/ui/${comp}'\``, '', `Exports: ${exports.join(', ')}`]
	for (const [key, opts] of Object.entries(variants)) lines.push(`\n${key}: ${opts.map((o) => `\`${o}\``).join(' · ')}`)
	if (EXAMPLES[comp]) lines.push('', EXAMPLES[comp]!)
	sections.push(lines.join('\n'))
}

mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(
	join(OUT_DIR, 'components.md'),
	`<!-- GENERATED by scripts/gen/genKitReference.mts from the template's actual kit source — do not edit by hand. -->\n# Kit reference — every component, its exports, variants, and canonical usage\n\n## Contents\n${toc.join('\n')}\n\n${sections.join('\n\n')}\n`,
)
console.log(`wrote ${join(OUT_DIR, 'components.md')} — ${files.length} components`)
