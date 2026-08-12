// REFERENCE PAGE — portfolio / studio landing (category: landing, variant: portfolio). Authored for
// the `editorial` preset. Never shipped to a project.
//
// A portfolio's product IS the work, so the page inverts the SaaS shape: the hero is small and the
// WORK GRID is the main event. Archetype: Hero(centered) → work grid → about → StatStrip →
// CTASection(panel) → Footer. No pricing, no feature bento, no logo wall of customers.
//
// The grid is the imagery lesson in miniature: `<Photo web="…" seed={p.id}>` per project, so every
// card shows a DISTINCT subject-relevant photo. `photoFor()` here would draw from a ~2-photo pool and
// every project would look like the same building.

import { ArrowUpRight, Mail, PenTool } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CTASection } from '@/components/blocks/CTASection'
import { Footer } from '@/components/blocks/Footer'
import { Hero } from '@/components/blocks/Hero'
import { MediaCard } from '@/components/blocks/MediaCard'
import { Photo } from '@/components/blocks/Photo'
import { Section } from '@/components/blocks/Section'
import { StatStrip } from '@/components/blocks/StatStrip'

// Imagery keywords live on the DATA, next to the thing they describe (see the data skill) — never
// hard-coded at the call site, so reordering the grid can never desync a photo from its label.
const WORK = [
	{ id: 'w1', name: 'Hallam Bakery', discipline: 'Identity · Packaging', year: '2026', image: 'artisan bakery interior' },
	{ id: 'w2', name: 'North Shore Swim Club', discipline: 'Identity · Signage', year: '2025', image: 'outdoor swimming pool' },
	{ id: 'w3', name: 'Fieldnote', discipline: 'Product · Web', year: '2025', image: 'notebook desk workspace' },
	{ id: 'w4', name: 'Osmond Coffee', discipline: 'Packaging', year: '2025', image: 'coffee packaging bags' },
	{ id: 'w5', name: 'The Longcut', discipline: 'Editorial · Print', year: '2024', image: 'magazine spread print' },
	{ id: 'w6', name: 'Trimble Ceramics', discipline: 'Identity · Web', year: '2024', image: 'ceramic pottery studio' },
]

export function LandingPortfolio() {
	return (
		<div>
			<Hero
				layout="centered"
				badge={<Badge variant="secondary">Taking work for Q3</Badge>}
				headline={
					<>
						A small studio for <span className="text-muted-foreground">careful brands.</span>
					</>
				}
				subcopy="Fold & Field is Marta Oyelaran and Sam Okafor. We make identities, packaging, and the websites that carry them — six projects a year, no more."
				actions={
					<Button size="lg">
						Start a project <ArrowUpRight className="size-4" />
					</Button>
				}
			/>

			<Section eyebrow="Selected work" heading="Six things we made recently">
				<div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
					{WORK.map((p) => (
						<MediaCard
							key={p.id}
							media={<Photo web={p.image} seed={p.id} kind="product" alt={p.name} />}
							title={p.name}
							meta={p.discipline}
							aside={<span className="text-sm text-muted-foreground tabular-nums">{p.year}</span>}
						/>
					))}
				</div>
			</Section>

			<Section tone="muted" eyebrow="How we work" heading="Two people, start to finish">
				<div className="grid gap-8 md:grid-cols-2">
					<p className="text-lg text-muted-foreground">
						No account managers and no handover. The people you meet in the first call are the people who draw the marks, set the type, and write the CSS — which is
						why we take six projects a year instead of thirty.
					</p>
					<p className="text-lg text-muted-foreground">
						Most engagements run eight to twelve weeks and end with a system your team can actually operate: tokens, components, and a document that explains the
						decisions rather than just showing the outcome.
					</p>
				</div>
			</Section>

			<Section>
				<StatStrip
					stats={[
						{ value: '11 yr', label: 'Studio, running' },
						{ value: '6', label: 'Projects a year' },
						{ value: '2', label: 'People on every one' },
					]}
				/>
			</Section>

			<CTASection
				variant="panel"
				headline="Tell us what you are making"
				subcopy="A paragraph is plenty. We reply to everything within two working days, including the ones we cannot take."
				actions={
					<Button size="lg">
						<Mail className="size-4" /> hello@foldandfield.studio
					</Button>
				}
				fineprint="Q3 has two slots left · We work with teams of any size"
			/>

			<Footer
				brand={
					<>
						<PenTool className="size-4 text-primary" /> Fold &amp; Field
					</>
				}
				tagline="Identity, packaging, and the web that carries them."
				columns={[
					{ heading: 'Studio', links: ['Work', 'About', 'Process', 'Contact'] },
					{ heading: 'Elsewhere', links: ['Instagram', 'Are.na', 'Read.cv', 'Newsletter'] },
				]}
				fineprint="© 2026 Fold & Field. Sheffield and Lisbon."
			/>
		</div>
	)
}
