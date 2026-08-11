// Starter showcase (delete src/demo/ when building the real app). A complete premium landing page
// assembled ONLY from blocks + kit + tokens — this is what "designed, not scaffolded" looks like.

import { Leaf, ShieldCheck, Sparkles, Truck } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ArtImage } from '@/components/blocks/ArtImage'
import { FeatureGrid } from '@/components/blocks/FeatureGrid'
import { Footer } from '@/components/blocks/Footer'
import { Hero } from '@/components/blocks/Hero'
import { MediaCard } from '@/components/blocks/MediaCard'
import { Photo } from '@/components/blocks/Photo'
import { Section } from '@/components/blocks/Section'
import { StatStrip } from '@/components/blocks/StatStrip'
import { photo } from '@/lib/photos'

const PRODUCTS = [
	{ name: 'Meridian Field Watch', price: '$189.00', meta: 'Instruments', img: photo('product-watch') },
	{ name: 'Trailline Runner', price: '$129.00', meta: 'Footwear', img: photo('product-shoe') },
	{ name: 'Atlas Daypack', price: '$98.00', meta: 'Carry', img: null },
	{ name: 'Harbor Ceramic Set', price: '$64.00', meta: 'Home', img: null },
	{ name: 'Ridge Enamel Mug', price: '$28.00', meta: 'Home', img: null },
	{ name: 'Coastline Throw', price: '$86.00', meta: 'Textiles', img: null },
]

export function GalleryLanding() {
	return (
		<div>
			<Hero
				badge={<Badge variant="secondary">New — the Autumn collection</Badge>}
				headline="Objects made to be kept, not replaced."
				subcopy="Meridian makes small-batch goods for people who notice the difference. Considered materials, honest prices, lifetime repairs."
				actions={
					<>
						<Button size="lg">Shop the collection</Button>
						<Button size="lg" variant="outline">
							Our story
						</Button>
					</>
				}
				media={<img src={photo('product-watch')} alt="Meridian field watch on linen" />}
			/>

			<Section tone="muted" eyebrow="Why Meridian" heading="Built for the long haul" description="Every piece earns its place — no filler, no seasonal churn.">
				<FeatureGrid
					features={[
						{ icon: ShieldCheck, title: 'Lifetime repairs', description: 'Send anything back, any time. We mend it and return it.' },
						{ icon: Leaf, title: 'Traceable materials', description: 'Every supplier named, every mill visited, every year.' },
						{ icon: Truck, title: 'Carbon-neutral delivery', description: 'Ground-first logistics, plastic-free packaging.' },
					]}
				/>
			</Section>

			<Section eyebrow="The collection" heading="This season's bestsellers" description="Six pieces, chosen slowly.">
				<div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
					{PRODUCTS.map((p) => (
						<MediaCard
							key={p.name}
							media={p.img ? <img src={p.img} alt={p.name} /> : <ArtImage seed={p.name} kind="product" />}
							title={p.name}
							meta={p.meta}
							aside={p.price}
							actions={
								<Button size="sm" variant="outline">
									Add to cart
								</Button>
							}
						/>
					))}
				</div>
			</Section>

			<Section tone="muted">
				<StatStrip
					stats={[
						{ value: '12 yrs', label: 'making goods' },
						{ value: '48k', label: 'repairs completed' },
						{ value: '4.9★', label: 'average review' },
						{ value: '0', label: 'landfilled returns' },
					]}
				/>
			</Section>

			{/* Distinct-subject cards route through <Photo web> — the imagery rule this page exemplifies
			    (photoFor is for a SINGLE hero/banner; on grids its ~2-per-category pack visibly repeats). */}
			<Section eyebrow="Field notes" heading="From the workshop">
				<div className="grid gap-6 md:grid-cols-2">
					<MediaCard media={<Photo web="textile mill workshop" seed="workshop-notes" alt="The Meridian workshop" />} title="Why we visit every mill ourselves" meta="Provenance · 6 min read" />
					<MediaCard media={<Photo web="coastal hiking trail" seed="coast-notes" alt="Coastal trail" />} title="Testing the Trailline on 400 km of coast path" meta="Field test · 9 min read" />
				</div>
			</Section>

			<Footer
				brand={
					<span className="flex items-center gap-2">
						<Sparkles className="size-4 text-primary" /> Meridian
					</span>
				}
				tagline="Small-batch goods, made to be kept."
				columns={[
					{ heading: 'Shop', links: ['Instruments', 'Carry', 'Home', 'Textiles'] },
					{ heading: 'Company', links: ['Our story', 'Repairs', 'Journal'] },
					{ heading: 'Support', links: ['Shipping', 'Returns', 'Contact'] },
				]}
				fineprint="© 2026 Meridian Goods Co. Demo page — every pixel from the block kit."
			/>
		</div>
	)
}
