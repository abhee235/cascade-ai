// scripts/gen/genKitReference.mts — generate the design skill's component reference FROM THE ACTUAL KIT
// SOURCE (ADR-055 reference pattern; user requirement: "refer to the codebase for designing frontends,
// the written skills look vague"). Extracts every export and every cva variant/size option from
// src/components/ui/*.tsx, so the reference is exact and regenerates when the kit changes.
//
//   npx tsx scripts/gen/genKitReference.mts   (run after any kit change; commit the output)

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..')
const UI = join(ROOT, 'packages', 'server', 'templates', 'react', 'src', 'components', 'ui')
const BLOCKS = join(ROOT, 'packages', 'server', 'templates', 'react', 'src', 'components', 'blocks')
const OUT_DIR = join(ROOT, 'packages', 'server', 'skills', 'builder', 'design', 'reference')

/** Hand-written composition examples for the workhorses (generated facts + curated usage = precise AND practical). */
const EXAMPLES: Record<string, string> = {
	sonner: `\`\`\`tsx
// Mount ONCE in App, then call toast() from anywhere. This is the "feedback after an action" rule:
// every create/update/delete says something, or the user cannot tell whether it worked.
<Toaster />                                  // in App.tsx, beside your view switch
toast.success('Order placed')                // after a successful submit
toast.error('Could not save — try again')    // after a failure
\`\`\``,
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

/** Hand-written composition examples for the blocks (same idea: generated facts + curated usage). */
const BLOCK_EXAMPLES: Record<string, string> = {
	StatCard: `\`\`\`tsx
// A dashboard's top row is 3–4 of these. Values are DERIVED (useMemo), never hardcoded, and always
// carry a comparison — a number with nothing to compare it to tells the reader nothing.
// delta renders as a badge top-right; trendLabel is the takeaway, note is the quiet context line.
<StatCard label="Revenue (paid)" value={\`$\${revenue.toLocaleString()}\`} delta={12.4}
  trendLabel="Trending up this month" note="Paid invoices in the current view" icon={CreditCard} />
<StatCard label="Failure rate" value="0.42%" delta={-1.1} trendLabel="Fewer failures" lowerIsBetter />  // down = good
\`\`\``,
	AppShell: `\`\`\`tsx
// EVERY signed-in view (dashboard, admin, settings, account) lives inside one of these. A bare centred
// column reads as a marketing page, not a product.
<AppShell
  brand={<><BarChart3 className="size-4 text-primary" /> Cadence</>}
  groups={[
    { items: [{ label: 'Overview', icon: LayoutDashboard, active: true }, { label: 'Runs', icon: Package }] },
    { heading: 'Billing', items: [{ label: 'Invoices', icon: FileText, onClick: () => setView('invoices') }] },
  ]}
  user={<div className="flex items-center gap-3"><Avatar className="size-8"><AvatarFallback>AR</AvatarFallback></Avatar>…</div>}
  header="Overview"
  headerActions={<Button>New invoice</Button>}
>
  {/* StatCard row → ChartCards → DataTable */}
</AppShell>
\`\`\``,
	ChartCard: `\`\`\`tsx
// ONE series per card. tone picks the preset's chart colour; the block handles axes, grid and tooltip.
<ChartCard title="Runs per day" description="Scheduled and manual." kind="area" tone={1}
  data={[{ label: 'Mon', value: 820 }, { label: 'Tue', value: 932 }]} />
// In your OWN chart code use the PRESET vars — var(--chart-1), var(--border) — never var(--color-chart-1):
// Tailwind only emits a --color-* alias when a utility uses it, so that one is empty at runtime.
\`\`\``,
	DataTable: `\`\`\`tsx
// Sorting/filtering happen ONCE upstream in a useMemo; this block just renders and reports sort clicks.
const columns: DataColumn<Order>[] = [
  { key: 'id', header: 'Invoice', cell: (o) => o.id, sortable: true },
  { key: 'status', header: 'Status', cell: (o) => <Badge variant="secondary">{o.status}</Badge> },
  { key: 'amount', header: 'Amount', cell: (o) => \`$\${o.amount}\`, numeric: true, sortable: true },
]
<DataTable columns={columns} rows={rows} rowKey={(o) => o.id} sort={sort}
  onSortChange={(key) => setSort((s) => ({ key, dir: s.key === key && s.dir === 'desc' ? 'asc' : 'desc' }))}
  empty={<EmptyState title="No invoices match" action={<Button variant="outline" onClick={clear}>Clear filters</Button>} />} />
\`\`\``,
	FilterBar: `\`\`\`tsx
// Active filters must be VISIBLE (chips) and reversible (clear) — a filtered list that looks like an
// empty list is the most common way a dashboard lies to its user.
<FilterBar query={query} onQueryChange={setQuery} placeholder="Search invoices…"
  chips={plan === 'all' ? [] : [{ label: \`Plan: \${plan}\`, onRemove: () => setPlan('all') }]}
  onClear={dirty ? clearAll : undefined} action={<Button>New invoice</Button>}>
  <Select value={plan} onValueChange={setPlan}>…</Select>
</FilterBar>
\`\`\``,
	PricingTable: `\`\`\`tsx
// 2–4 tiers, EXACTLY ONE highlighted — an undifferentiated row makes the visitor choose, and they leave.
<PricingTable tiers={[
  { name: 'Solo', price: '$0', period: 'mo', features: ['3 pipelines'], action: <Button variant="outline">Start free</Button> },
  { name: 'Team', price: '$49', period: 'mo', features: ['Unlimited', 'On-call routing'],
    action: <Button>Start trial</Button>, highlighted: true },
  { name: 'Company', price: 'Custom', features: ['SSO', 'Residency'], action: <Button variant="outline">Talk to us</Button> },
]} />
\`\`\``,
	Testimonial: `\`\`\`tsx
// variant="cards" for 2–3 voices · variant="feature" for one strong quote. Real names + roles only.
<Testimonial variant="feature" quotes={[
  { quote: 'We deleted 4,000 lines of glue in a fortnight.', author: 'Priya Raman', role: 'Staff Engineer, Kestrel' },
]} />
\`\`\``,
	FAQ: `\`\`\`tsx
// Answer what BLOCKS a purchase (price, cancellation, data, support) — not what flatters the product.
<FAQ items={[
  { question: 'Can I self-host?', answer: 'Yes — the runner is a single binary, on every plan.' },
  { question: 'Do you charge per seat?', answer: 'No. Pricing follows pipelines and run minutes.' },
]} />
\`\`\``,
	CTASection: `\`\`\`tsx
// The closing ask — the last band before the Footer. variant="full" paints it primary edge-to-edge.
<CTASection
  headline="Put your first pipeline on a schedule tonight"
  subcopy="Fork a template, point it at your warehouse."
  actions={<><Button size="lg">Start free</Button><Button size="lg" variant="outline">Read the docs</Button></>}
  fineprint="No card required · Cancel in one click"
/>
\`\`\``,
	CartRow: `\`\`\`tsx
// One cart line. The stepper + remove are what make a cart feel real; a static list reads as a receipt.
{lines.map((l) => (
  <CartRow key={l.id} media={<Photo web={l.name} seed={l.id} kind="product" />} title={l.name}
    unitPrice={\`$\${l.price.toFixed(2)}\`} quantity={l.qty} lineTotal={\`$\${(l.price * l.qty).toFixed(2)}\`}
    onQuantityChange={(d) => changeQty(l.id, d)} onRemove={() => remove(l.id)} />
))}
\`\`\``,
	CheckoutPanel: `\`\`\`tsx
// Summary beside the form. Validate ON SUBMIT (forms skill); swap in \`confirmation\` after success.
<CheckoutPanel
  lines={[{ label: 'Subtotal', value: '$318.00' }, { label: 'Shipping', value: 'Free', muted: true }]}
  total="$318.00"
  action={<Button type="submit" disabled={!valid}>Place order</Button>}
>
  <Label htmlFor="email">Email</Label>
  <Input id="email" value={form.email} onChange={set('email')} aria-invalid={!!errors.email} />
</CheckoutPanel>
\`\`\``,
	BentoGrid: `\`\`\`tsx
// The modern feature band: MIXED-weight tiles, not a row of identical cards.
// Compose 4–7: one media anchor (span 2), one or two stats, ONE accent tile for the CTA, rest plain.
<BentoGrid
  tiles={[
    { kind: 'media', span: 2, title: 'Repaired, not replaced', description: 'Send it back any year.',
      media: <Photo web="leather workshop" seed="bench" kind="product" /> },
    { kind: 'stat', value: '11 yrs', label: 'Median product lifespan' },
    { kind: 'plain', icon: ShieldCheck, title: 'Lifetime repairs', description: 'Free for a decade.' },
    { kind: 'accent', title: 'Join the list', description: 'One letter a month.',
      action: <Button variant="secondary">Subscribe</Button> },
  ]}
/>
\`\`\``,
	LogoStrip: `\`\`\`tsx
// Social proof under the hero. Plain TEXT wordmarks are the intended default — credible with zero assets.
<LogoStrip
  label="Stocked by independent shops in 14 countries"
  items={['Northline', 'Hallowell', 'Studio Mena', 'The Good Press', 'Fieldnote', 'Vestry & Co']}
/>
\`\`\``,
	Photo: `\`\`\`tsx
// The DEFAULT for any grid/list of distinct subjects: a real, deterministic photo per item, with an
// automatic <ArtImage> fallback if the host is blocked or slow — never a broken box.
{products.map((p) => (
  <MediaCard key={p.id} title={p.name} meta={p.category}
    media={<Photo web="leather watch minimal" seed={p.id} kind="product" />} />
))}
// NEVER photoFor() across a list — the bundled pack holds ~2 photos per category, so every card repeats.
\`\`\``,
	NavBar: `\`\`\`tsx
<NavBar
  brand={<><Sparkles className="size-4 text-primary" /> Meridian</>}
  links={<><a className="text-sm text-muted-foreground hover:text-foreground">Shop</a>…</>}
  actions={<Button variant="ghost" size="icon" onClick={toggleDark}>{dark ? <Sun/> : <Moon/>}</Button>}
/>
\`\`\``,
	Hero: `\`\`\`tsx
<Hero
  badge={<Badge variant="secondary">New — Spring drop</Badge>}
  headline="Objects made to be kept."
  subcopy="One supporting sentence, not three."
  actions={<><Button size="lg">Shop now</Button><Button size="lg" variant="outline">Learn more</Button></>}
  media={<img src={photoFor('hero', 'product')} alt="…" />}   // or <ArtImage seed="hero" kind="banner" />
  layout="split"  // split | centered | bleed
/>
\`\`\``,
	Section: `\`\`\`tsx
<Section eyebrow="How it works" heading="Three steps" description="One line." tone="muted">
  {/* any content — grids, FeatureGrid, StatStrip… */}
</Section>
\`\`\``,
	PageHeader: `\`\`\`tsx
<PageHeader title="Catalog" description="128 products" actions={<><Input placeholder="Search…" /><Button>Add product</Button></>} />
\`\`\``,
	FeatureGrid: `\`\`\`tsx
<FeatureGrid features={[{ icon: Truck, title: 'Free shipping', description: 'Over $50, everywhere.' }, …]} />
\`\`\``,
	MediaCard: `\`\`\`tsx
<MediaCard
  media={p.img ? <img src={p.img} alt={p.name} /> : <ArtImage seed={p.name} kind="product" />}
  title={p.name} meta={p.category} aside={\`$\${p.price.toFixed(2)}\`}
  actions={<Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); addToCart(p) }}>Add to cart</Button>}
  onClick={() => openDetail(p)}
/>
\`\`\``,
	StatStrip: `\`\`\`tsx
<StatStrip stats={[{ value: '12 yrs', label: 'making goods' }, { value: '48k', label: 'repairs' }]} />
\`\`\``,
	EmptyState: `\`\`\`tsx
<EmptyState icon={ShoppingCart} title="Your cart is empty" description="Find something you'll keep." action={<Button variant="outline" onClick={goCatalog}>Browse</Button>} />
\`\`\``,
	Footer: `\`\`\`tsx
<Footer brand="Meridian" tagline="Small-batch goods." columns={[{ heading: 'Shop', links: ['Instruments', 'Home'] }]} fineprint="© 2026 Meridian" />
\`\`\``,
	ArtImage: `\`\`\`tsx
<ArtImage seed={product.name} kind="product" />   // deterministic token-colored art — same seed, same art
<ArtImage seed={user.name} kind="avatar" />        // initials avatar
\`\`\``,
}

const PAGE_ASSEMBLY = `## Canonical page assembly

A landing page is blocks top-to-bottom; an app view is PageHeader + content; EVERY list has an EmptyState:

\`\`\`tsx
// Landing:                                  // App view (catalog, dashboard…):
<main className="min-h-screen bg-background text-foreground">
  <NavBar brand={…} actions={…} />             <NavBar brand={…} actions={…} />
  <Hero headline={…} actions={…} media={…} />  <PageHeader title="Catalog" actions={…} />
  <Section tone="muted" …><FeatureGrid …/></Section>
  <Section …>{/* MediaCard grid */}</Section>  <Section>{items.length ? grid : <EmptyState …/>}</Section>
  <Section tone="muted"><StatStrip …/></Section>
  <Footer brand={…} … />
</main>
\`\`\``

/** Pull `variants: { key: { option: …, option: … } }` out of a cva() call with a brace WALKER (formatting-
 *  independent). Keys at depth 1 are variant axes; keys at depth 2 are their options. */
function stripComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

function extractVariants(raw: string): Record<string, string[]> {
	const src = stripComments(raw) // a `Word:` inside a comment used to become a phantom variant option
	const out: Record<string, string[]> = {}
	const start = src.indexOf('variants:')
	if (start === -1) return out
	const open = src.indexOf('{', start)
	if (open === -1) return out
	let depth = 0
	let axis = ''
	let inString: string | null = null
	let stringStart = -1
	for (let i = open; i < src.length; i++) {
		const ch = src[i]!
		if (inString) {
			if (ch === inString && src[i - 1] !== '\\') {
				// A QUOTED key ('icon-xs': …) is still a key. Skipping these under-reported the kit —
				// the reference advertised 5 button sizes where the source defines 8.
				const word = src.slice(stringStart + 1, i)
				if (/^[\w-]+$/.test(word) && /^\s*:/.test(src.slice(i + 1))) {
					if (depth === 1) {
						axis = word
						out[axis] = []
					} else if (depth === 2 && axis) out[axis]!.push(word)
				}
				inString = null
			}
			continue
		}
		if (ch === '"' || ch === "'" || ch === '`') {
			inString = ch
			stringStart = i
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

/** Extract the component's PROPS: every field of `export interface <X>Props` with its type and doc.
 *  Without this the reference lists exports and nothing else — measured rot: Hero.layout / Section.tone
 *  (plain union props, not cva variants) existed only inside hand-written examples, so a model reading
 *  the reference could not discover them. */
function extractProps(raw: string): { name: string; type: string; doc?: string }[] {
	// Normalise CRLF FIRST. The per-prop regex below matches to end of line, but a dot never matches a
	// carriage return and the end anchor does not see one either — so on a Windows checkout EVERY prop line
	// failed to parse and this reference regenerated with NO Props lines at all, for every block.
	const src = stripComments(raw).replace(/\r\n/g, '\n')
	// `[^{]*` so `interface XProps extends VariantProps<typeof …>` still matches — the exact rot this
	// function exists to kill (NavBar's brand/links/actions were undocumented because of `\s*`).
	const m = /export interface \w+Props[^{]*{([\s\S]*?)\n}/.exec(src)
	if (!m) return []
	const props: { name: string; type: string; doc?: string }[] = []
	for (const line of m[1]!.split('\n')) {
		const p = /^\s*(\w+)(\??):\s*(.+?)(?:$|\s*\/\/)/.exec(line)
		if (p) props.push({ name: p[1]! + (p[2] ? '?' : ''), type: p[3]!.replace(/;\s*$/, '').trim() })
	}
	return props
}

/** Extract `export function X` / `export const X` names too (blocks export functions, not const lists). */
function extractExports(src: string): string[] {
	const braces = [...src.matchAll(/export \{([\s\S]*?)\}/g)].flatMap((m) => m[1]!.split(',').map((s) => s.trim()).filter((s) => s && !s.startsWith('type ')))
	const direct = [...src.matchAll(/export (?:function|const) (\w+)/g)].map((m) => m[1]!)
	return [...new Set([...braces, ...direct])]
}

/** Render one directory of components into markdown sections. `alias` is the import path segment. */
function renderDir(dir: string, alias: string, examples: Record<string, string>): { sections: string[]; toc: string[]; count: number } {
	const files = readdirSync(dir).filter((f) => f.endsWith('.tsx')).sort()
	const sections: string[] = []
	const toc: string[] = []
	for (const f of files) {
		const src = readFileSync(join(dir, f), 'utf8')
		const comp = basename(f, '.tsx')
		const exports = extractExports(src)
		const variants = extractVariants(src)
		toc.push(`- ${comp}`)
		const lines = [`## ${comp}`, '', `Import: \`import { ${exports.slice(0, 4).join(', ')}${exports.length > 4 ? ', …' : ''} } from '@/components/${alias}/${comp}'\``, '', `Exports: ${exports.join(', ')}`]
		const props = extractProps(src)
		if (props.length) lines.push('', `Props: ${props.map((p) => `\`${p.name}: ${p.type}\``).join(' · ')}`)
		for (const [key, opts] of Object.entries(variants)) lines.push(`\n${key}: ${opts.map((o) => `\`${o}\``).join(' · ')}`)
		if (examples[comp]) lines.push('', examples[comp]!)
		sections.push(lines.join('\n'))
	}
	return { sections, toc, count: files.length }
}

const kit = renderDir(UI, 'ui', EXAMPLES)
const kitMd = `<!-- GENERATED by scripts/gen/genKitReference.mts from the template's actual kit source — do not edit by hand. -->\n# Kit reference — every component, its exports, variants, and canonical usage\n\n## Contents\n${kit.toc.join('\n')}\n\n${kit.sections.join('\n\n')}\n`

const blocks = renderDir(BLOCKS, 'blocks', BLOCK_EXAMPLES)
const blocksMd = `<!-- GENERATED by scripts/gen/genKitReference.mts from the template's actual blocks source — do not edit by hand. -->\n# Blocks reference — page-section components. Pages are BLOCK COMPOSITIONS: assemble these, fill their slots with the kit.\n\n## Contents\n${blocks.toc.join('\n')}\n\n${blocks.sections.join('\n\n')}\n\n${PAGE_ASSEMBLY}\n`

// ── Category page references (design-overhaul P3 slice 5) ────────────────────────────────────────────
// The demo/ pages are the CANONICAL page assemblies — full, runnable, and reviewed by eye in the gallery.
// Prose describing them rots the moment a page changes (the same failure that put a phantom NavBar
// variant and a missing Photo block into blocks.md). So each category skill's page reference is the page
// SOURCE, verbatim: it cannot drift from what actually renders, because it IS what renders.
const DEMO_PAGES = join(ROOT, 'packages', 'server', 'templates', 'react', 'demo', 'pages')
const SKILLS = join(ROOT, 'packages', 'server', 'skills', 'builder')

const CATEGORY_PAGES: { category: string; blurb: string; files: string[] }[] = [
	{ category: 'commerce', blurb: 'The whole shop — catalog → detail → cart → checkout → confirmation, with the cart as the ONE piece of stored state.', files: ['ShopCatalog.tsx'] },
	{ category: 'dashboard', blurb: 'The signed-in overview — AppShell chrome, a KPI row, charts, and a filtered data table.', files: ['DashboardHome.tsx'] },
	{ category: 'landing', blurb: 'Four landing archetypes. They differ in STRUCTURE, not just copy: pick the one whose shape matches the ask.', files: ['LandingSaaS.tsx', 'LandingLaunch.tsx', 'LandingPortfolio.tsx', 'LandingWaitlist.tsx'] },
	{ category: 'app-shell', blurb: 'The screens every app needs — sign-in, account/settings, notifications, search, and the four data states.', files: ['AppShellPages.tsx'] },
	{ category: 'social', blurb: 'The feed set — one posts array driving feed, post detail with replies, and profile; a composer that clears on submit.', files: ['SocialFeed.tsx'] },
	// `category` doubles as the SKILL DIRECTORY name — the game pages belong to the game-dev skill.
	{ category: 'game-dev', blurb: 'The four screens around any game — menu, layout-stable HUD, game-over with the run\'s numbers, persistent top-5 leaderboard.', files: ['GameArcade.tsx'] },
]

function pagesReference(category: string, blurb: string, files: string[]): string {
	const bodies = files.map((f) => {
		const src = readFileSync(join(DEMO_PAGES, f), 'utf8').trimEnd()
		return `## ${f.replace(/\.tsx$/, '')}\n\n\`\`\`tsx\n${src}\n\`\`\``
	})
	return (
		`<!-- GENERATED by scripts/gen/genKitReference.mts from templates/react/demo/pages — do not edit by hand. -->\n` +
		`# ${category} — the reference page${files.length > 1 ? 's' : ''}, verbatim\n\n${blurb}\n\n` +
		`This is the ACTUAL source of a page that renders in the gallery, not a description of one. Copy its\n` +
		`SHAPE — the block composition, the state placement, the derived values — not its content: the brand,\n` +
		`the copy, and the data must all come from the user's brief.\n\n${bodies.join('\n\n')}\n`
	)
}

const OUTPUTS: [string, string, number, string][] = [
	[join(OUT_DIR, 'components.md'), kitMd, kit.count, 'components'],
	[join(OUT_DIR, 'blocks.md'), blocksMd, blocks.count, 'blocks'],
	...CATEGORY_PAGES.map(({ category, blurb, files }): [string, string, number, string] => [
		join(SKILLS, category, 'reference', 'pages.md'),
		pagesReference(category, blurb, files),
		files.length,
		`${category} page(s)`,
	]),
]

// --check: the FRESHNESS GATE (a test runs this). Nothing enforced regeneration before, and the reference
// silently rotted — the Photo block missing entirely, a phantom NavBar variant, stale button sizes.
if (process.argv.includes('--check')) {
	const stale = OUTPUTS.filter(([path, md]) => {
		let current = ''
		try {
			current = readFileSync(path, 'utf8')
		} catch {
			/* missing counts as stale */
		}
		return current.replace(/\r\n/g, '\n') !== md.replace(/\r\n/g, '\n')
	}).map(([path]) => relative(ROOT, path).replaceAll('\\', '/'))
	if (stale.length) {
		console.error(`STALE reference(s): ${stale.join(', ')} — run \`npx tsx scripts/gen/genKitReference.mts\` and commit the output.`)
		process.exit(1)
	}
	console.log('references are fresh')
	process.exit(0)
}

for (const [path, md, count, kind] of OUTPUTS) {
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, md)
	console.log(`wrote ${relative(ROOT, path).replaceAll('\\', '/')} — ${count} ${kind}`)
}
