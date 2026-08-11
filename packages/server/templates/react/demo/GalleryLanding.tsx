// The LOOK — the canonical modern landing page, assembled ONLY from blocks + kit + tokens. This is the
// exemplar a model copies, so it deliberately demonstrates the CURRENT landing vocabulary (verified
// against the 21st.dev catalog, 2026-08): a two-tone display headline, a collage hero with depth, a
// wordmark trust strip, a BENTO band of mixed-weight tiles, then the product grid, a gradient-wash
// editorial band, and a closing CTA. Nothing here is bespoke CSS — every effect is a block prop.
// (This dir never ships to a generated project; it lives in the template for review + reference.)

import { Compass, Leaf, Recycle, ShieldCheck, Sparkles, Truck } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ArtImage } from '@/components/blocks/ArtImage'
import { BentoGrid } from '@/components/blocks/BentoGrid'
import { FeatureGrid } from '@/components/blocks/FeatureGrid'
import { Footer } from '@/components/blocks/Footer'
import { Hero } from '@/components/blocks/Hero'
import { LogoStrip } from '@/components/blocks/LogoStrip'
import { MediaCard } from '@/components/blocks/MediaCard'
import { Section } from '@/components/blocks/Section'
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
			{/* Hero: two-tone headline (the second clause drops to muted — the current landing idiom) and
			    layout="collage", which layers the photo over offset token-tinted panels. */}
			<Hero
				layout="collage"
				badge={
					<Badge variant="secondary" className="gap-1.5">
						<Sparkles className="size-3" /> New — the Autumn collection
					</Badge>
				}
				headline={
					<>
						Objects made to be kept, <span className="text-muted-foreground">not replaced.</span>
					</>
				}
				subcopy="Meridian makes small-batch goods for people who notice the difference. Considered materials, honest prices, lifetime repairs."
				actions={
					<>
						<Button size="lg">Shop the collection</Button>
						<Button size="lg" variant="outline">
							Our story
						</Button>
					</>
				}
				media={<img src={photo('product-watch')} alt="The Meridian field watch" />}
			/>

			{/* Trust strip — wordmarks, not logos: credible while prototyping, zero assets. */}
			<Section>
				<LogoStrip
					label="Stocked by independent shops in 14 countries"
					items={['Northline', 'Hallowell', 'Studio Mena', 'The Good Press', 'Fieldnote', 'Vestry & Co']}
				/>
			</Section>

			{/* BENTO — mixed-weight tiles instead of a row of identical cards: one media anchor, two stats,
			    one filled accent tile carrying the CTA, plus plain tiles. The 2026 feature-section idiom. */}
			<Section tone="muted" eyebrow="Why Meridian" heading="Built for the long haul" description="Every piece earns its place — no filler, no seasonal churn.">
				<BentoGrid
					tiles={[
						{
							kind: 'media',
							span: 2,
							title: 'Repaired, not replaced',
							description: 'Send anything back, any year — we fix it and return it.',
							media: <img src={photo('workspace-code')} alt="The repair bench" />,
						},
						{ kind: 'stat', value: '11 yrs', label: 'Median product lifespan' },
						{ kind: 'plain', icon: ShieldCheck, title: 'Lifetime repairs', description: 'Free for the first decade, at cost after.' },
						{ kind: 'plain', icon: Leaf, title: 'Traceable materials', description: 'Every mill and tannery named on the label.' },
						{ kind: 'accent', title: 'Join the workshop list', description: 'One letter a month: new pieces, repair clinics, field notes.', action: <Button variant="secondary">Subscribe</Button> },
					]}
				/>
			</Section>

			{/* The product grid — a bundled photo where one fits the subject, <ArtImage> otherwise; in a real
			    catalog use <Photo web="<subject>" seed={item.id}> so every card is a DISTINCT photo. */}
			<Section eyebrow="The collection" heading="Autumn, in six pieces" description="Small runs. Made to be used, not stored.">
				<div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
					{PRODUCTS.map((p) => (
						<MediaCard
							key={p.name}
							media={p.img ? <img src={p.img} alt={p.name} /> : <ArtImage seed={p.name} kind="product" />}
							title={p.name}
							meta={p.meta}
							aside={<span className="font-medium">{p.price}</span>}
							actions={
								<Button variant="outline" size="sm">
									Add to cart
								</Button>
							}
						/>
					))}
				</div>
			</Section>

			{/* Wash band — a soft gradient field built from the preset's own primary/accent. */}
			<Section tone="wash" eyebrow="Field notes" heading="From the workshop">
				<div className="grid gap-6 md:grid-cols-2">
					<MediaCard media={<img src={photo('interior-living')} alt="The Meridian workshop" />} title="Why we visit every mill ourselves" meta="Provenance · 6 min read" />
					<MediaCard media={<img src={photo('nature-beach')} alt="Coastal trail" />} title="Testing the Trailline on 400 km of coast path" meta="Field test · 9 min read" />
				</div>
			</Section>

			<Section>
				<FeatureGrid
					features={[
						{ icon: Truck, title: 'Free shipping over $75', description: 'Carbon-neutral, tracked, two to four days.' },
						{ icon: Recycle, title: 'Take-back programme', description: 'Send a worn piece back for credit; we rehome or recycle it.' },
						{ icon: Compass, title: 'Try it for 60 days', description: 'Use it properly. If it is not right, return it worn.' },
					]}
				/>
			</Section>

			<Footer
				brand={
					<>
						<Sparkles className="size-4 text-primary" /> Meridian
					</>
				}
				tagline="Small-batch goods, made to be kept."
				columns={[
					{ heading: 'Shop', links: ['New arrivals', 'Instruments', 'Carry', 'Home'] },
					{ heading: 'Company', links: ['Our story', 'Repairs', 'Stockists', 'Careers'] },
					{ heading: 'Support', links: ['Shipping', 'Returns', 'Care guide', 'Contact'] },
				]}
				fineprint="© 2026 Meridian Goods Co. All rights reserved."
			/>
		</div>
	)
}
