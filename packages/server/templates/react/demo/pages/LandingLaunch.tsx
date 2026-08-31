// REFERENCE PAGE — product-launch landing (category: landing, variant: launch). Authored for the
// `luxe-dark` preset. Never shipped to a project.
//
// A launch page is NOT a SaaS page with different words. There is one product, one date, and one ask,
// so: no pricing table, no feature matrix, no "compare plans". The archetype in order:
// Hero(bleed) → StatStrip → BentoGrid(specs) → Testimonial → FAQ → CTASection(full) → Footer.
//
// Hero `layout="bleed"` puts the photo edge to edge behind the headline — the loudest opening the kit
// has. It works exactly once per page, and only with a photo that survives having text on top of it.

import { Battery, Compass, Mountain, Radio } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { BentoGrid } from '@/components/blocks/BentoGrid'
import { CTASection } from '@/components/blocks/CTASection'
import { FAQ } from '@/components/blocks/FAQ'
import { Footer } from '@/components/blocks/Footer'
import { Hero } from '@/components/blocks/Hero'
import { Section } from '@/components/blocks/Section'
import { StatStrip } from '@/components/blocks/StatStrip'
import { Testimonial } from '@/components/blocks/Testimonial'
import { photo } from '@/lib/photos'

export function LandingLaunch() {
	return (
		<div>
			<Hero
				layout="bleed"
				badge={
					<Badge variant="secondary" className="gap-1.5">
						<Compass className="size-3" /> Shipping 14 March
					</Badge>
				}
				headline={
					<>
						Two weeks off-grid. <br />
						One charge.
					</>
				}
				subcopy="Kestrel is a trail watch built around a single question: how long can it stay useful when there is nothing to plug it into?"
				actions={
					<>
						<Button size="lg">Reserve yours — $340</Button>
						<Button size="lg" variant="outline">
							Read the field notes
						</Button>
					</>
				}
				media={<img src={photo('nature-mountain')} alt="A ridge line at first light" />}
			/>

			{/* Numbers first: a launch audience wants the claim quantified before it wants the story. */}
			<Section>
				<StatStrip
					stats={[
						{ value: '16 days', label: 'Typical battery, GPS on' },
						{ value: '38 mm', label: 'Titanium case' },
						{ value: '100 m', label: 'Water resistance' },
						{ value: '10 yr', label: 'Repair guarantee' },
					]}
				/>
			</Section>

			<Section tone="muted" eyebrow="What we changed" heading="Built by subtraction" description="Every part we removed bought battery, weight, or a fewer-things-to-break count.">
				<BentoGrid
					tiles={[
						{
							kind: 'media',
							span: 2,
							title: 'A screen you can read at noon',
							description: 'Memory-in-pixel, always on, no backlight tax. The sun is a feature here, not a problem.',
							media: <img src={photo('nature-beach')} alt="The Kestrel display in direct sun" />,
						},
						{ kind: 'stat', value: '0.4 W', label: 'Peak draw with GPS tracking' },
						{ kind: 'plain', icon: Battery, title: 'Replaceable cell', description: 'A coin cell you can change with a nickel, not a service centre.' },
						{ kind: 'plain', icon: Radio, title: 'Offline maps', description: '4 GB of vector topo on board. No signal, no subscription.' },
						{
							kind: 'accent',
							title: 'Field-test programme',
							description: 'Fifty units, six months, one very wet Cairngorms winter.',
							action: <Button variant="secondary">Read the log</Button>,
						},
					]}
				/>
			</Section>

			<Section tone="wash">
				<Testimonial
					variant="feature"
					quotes={[
						{
							quote:
								'I took it up the Cuillin ridge in February and came back with 61% left. The thing I keep telling people is duller than the battery, though: I never once opened a menu to do the thing I wanted to do.',
							author: 'Lena Fischer',
							role: 'Mountain leader, Fort William',
						},
					]}
				/>
			</Section>

			<Section eyebrow="Before you reserve" heading="The honest answers">
				<FAQ
					items={[
						{ question: 'When does it actually ship?', answer: 'The first 2,000 units ship 14 March. Reserve now and you are charged when yours leaves the workshop, not today.' },
						{ question: 'Is 16 days realistic?', answer: 'That is with GPS on and a one-second sample rate, measured across the field programme. Watch-only, with GPS off, it runs about five weeks.' },
						{ question: 'Can I replace the strap and the battery myself?', answer: 'Both, with a coin. Straps are a standard 22 mm; the cell is a CR2032 you can buy anywhere.' },
						{ question: 'What if I hate it?', answer: 'Sixty days, any condition, we pay the return. The repair guarantee runs ten years from delivery.' },
					]}
				/>
			</Section>

			{/* variant="full" is the loudest band the kit has — the closing ask on a launch page is the one
			    place it belongs, and it appears exactly once. */}
			<CTASection
				variant="full"
				headline="The first run is 2,000 watches"
				subcopy="Reserve now to hold a place in the March batch. Nothing is charged until yours ships."
				actions={<Button size="lg" variant="secondary">Reserve yours — $340</Button>}
				fineprint="Free returns for 60 days · Ten-year repair guarantee · Made in Sheffield"
			/>

			<Footer
				brand={
					<>
						<Mountain className="size-4 text-primary" /> Kestrel
					</>
				}
				tagline="Instruments for long days outside."
				columns={[
					{ heading: 'The watch', links: ['Specifications', 'Field notes', 'Straps', 'Repairs'] },
					{ heading: 'Support', links: ['Shipping', 'Returns', 'Warranty', 'Contact'] },
					{ heading: 'Company', links: ['Our workshop', 'Materials', 'Stockists', 'Press'] },
				]}
				fineprint="© 2026 Kestrel Instruments Ltd. Sheffield, England."
			/>
		</div>
	)
}
