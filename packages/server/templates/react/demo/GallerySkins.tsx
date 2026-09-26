// GALLERY: the skin review gate (design-overhaul P5). Every skinnable block, side by side in all three
// shipped looks — base / sharp / soft — so a skin is judged by EYE before it ships, same as presets are.
// Only the gallery can render variants together like this: it imports across the template root, which a
// generated project never can (skins/ is not copied). NavBars get `static` so three sticky/fixed bars
// don't fight; everything else renders exactly as apps see it.

import { Camera, Route } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ArtImage as BaseArtImage } from '@/components/blocks/ArtImage'
import { Footer as BaseFooter } from '@/components/blocks/Footer'
import { Section as BaseSection } from '@/components/blocks/Section'
import { Hero as BaseHero } from '@/components/blocks/Hero'
import { MediaCard as BaseMediaCard } from '@/components/blocks/MediaCard'
import { NavBar as BaseNavBar } from '@/components/blocks/NavBar'
import { StatCard as BaseStatCard } from '@/components/blocks/StatCard'
import { ArtImage as SharpArtImage } from '../skins/sharp/blocks/ArtImage'
import { Footer as SharpFooter } from '../skins/sharp/blocks/Footer'
import { Hero as SharpHero } from '../skins/sharp/blocks/Hero'
import { Section as SharpSection } from '../skins/sharp/blocks/Section'
import { MediaCard as SharpMediaCard } from '../skins/sharp/blocks/MediaCard'
import { NavBar as SharpNavBar } from '../skins/sharp/blocks/NavBar'
import { StatCard as SharpStatCard } from '../skins/sharp/blocks/StatCard'
import { ArtImage as SoftArtImage } from '../skins/soft/blocks/ArtImage'
import { Footer as SoftFooter } from '../skins/soft/blocks/Footer'
import { Hero as SoftHero } from '../skins/soft/blocks/Hero'
import { Section as SoftSection } from '../skins/soft/blocks/Section'
import { MediaCard as SoftMediaCard } from '../skins/soft/blocks/MediaCard'
import { NavBar as SoftNavBar } from '../skins/soft/blocks/NavBar'
import { StatCard as SoftStatCard } from '../skins/soft/blocks/StatCard'
import { photo } from '@/lib/photos'

const SKINS = [
	{ name: 'base', Hero: BaseHero, MediaCard: BaseMediaCard, NavBar: BaseNavBar, StatCard: BaseStatCard, Art: BaseArtImage, Foot: BaseFooter, Sect: BaseSection },
	{ name: 'sharp', Hero: SharpHero, MediaCard: SharpMediaCard, NavBar: SharpNavBar, StatCard: SharpStatCard, Art: SharpArtImage, Foot: SharpFooter, Sect: SharpSection },
	{ name: 'soft', Hero: SoftHero, MediaCard: SoftMediaCard, NavBar: SoftNavBar, StatCard: SoftStatCard, Art: SoftArtImage, Foot: SoftFooter, Sect: SoftSection },
] as const

function Row({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<section className="flex flex-col gap-3">
			<h2 className="text-sm font-medium uppercase tracking-[0.12em] text-muted-foreground">{title}</h2>
			{children}
		</section>
	)
}

export function GallerySkins() {
	return (
		<div className="mx-auto flex max-w-6xl flex-col gap-14 px-6 py-12">
			<p className="max-w-2xl text-muted-foreground">
				One interface, three implementations. Everything below receives IDENTICAL props — only the skin differs. This is the review gate for skin authoring, and
				the proof that `Restyle {'{op:"skin"}'}` can never break an app: if it renders here with shared props, it renders in every app.
			</p>

			<Row title="NavBar — solid variant">
				<div className="flex flex-col gap-6">
					{SKINS.map(({ name, NavBar }) => (
						<div key={name} className="flex flex-col gap-1.5">
							<span className="text-xs text-muted-foreground">{name}</span>
							<NavBar
								className="static"
								brand={
									<>
										<Camera className="size-4 text-primary" /> Halide Supply
									</>
								}
								links={<span className="text-sm text-muted-foreground">Shop</span>}
								actions={<Button size="sm">Cart</Button>}
							/>
						</div>
					))}
				</div>
			</Row>

			<Row title="MediaCard — same product, three skins">
				<div className="grid gap-6 lg:grid-cols-3">
					{SKINS.map(({ name, MediaCard }) => (
						<div key={name} className="flex flex-col gap-1.5">
							<span className="text-xs text-muted-foreground">{name}</span>
							<MediaCard
								media={<img src={photo('product-watch')} alt="Field watch" />}
								title="Alpine Field Watch"
								meta="Instruments"
								aside={<span>$189.00</span>}
								actions={<Button size="sm">Add to cart</Button>}
							/>
						</div>
					))}
				</div>
			</Row>

			<Row title="StatCard — same KPI, three skins">
				<div className="grid gap-6 lg:grid-cols-3">
					{SKINS.map(({ name, StatCard }) => (
						<div key={name} className="flex flex-col gap-1.5">
							<span className="text-xs text-muted-foreground">{name}</span>
							<StatCard label="Runs" value="1,204" delta={8.2} trendLabel="More routes covered" note="vs last week" icon={Route} />
						</div>
					))}
				</div>
			</Row>

			<Row title="ArtImage — same seed, three generative languages">
				<div className="grid gap-6 lg:grid-cols-3">
					{SKINS.map(({ name, Art }) => (
						<div key={name} className="flex flex-col gap-1.5">
							<span className="text-xs text-muted-foreground">{name}</span>
							<div className="overflow-hidden rounded-lg border [&_svg]:aspect-[4/3]">
								<Art seed="Alpine Field Watch" kind="product" />
							</div>
						</div>
					))}
				</div>
			</Row>

			<Row title="Section — wash tone, three skins">
				<div className="flex flex-col gap-6">
					{SKINS.map(({ name, Sect }) => (
						<div key={name} className="flex flex-col gap-1.5">
							<span className="text-xs text-muted-foreground">{name}</span>
							<div className="overflow-hidden rounded-lg border">
								<Sect tone="wash" eyebrow="Why teams switch" heading="Atmosphere, three ways" description="The same band, washed by each skin's own weather.">
									<div className="h-10" />
								</Sect>
							</div>
						</div>
					))}
				</div>
			</Row>

			<Row title="Footer — three skins">
				<div className="flex flex-col gap-6">
					{SKINS.map(({ name, Foot }) => (
						<div key={name} className="flex flex-col gap-1.5">
							<span className="text-xs text-muted-foreground">{name}</span>
							<div className="overflow-hidden rounded-lg border">
								<Foot brand={<><Camera className="size-4 text-primary" /> Halide Supply</>} tagline="Film and serviced bodies, checked by hand." columns={[{ heading: 'Shop', links: ['Film', 'Cameras'] }, { heading: 'Help', links: ['Shipping', 'Returns'] }]} fineprint="© 2026 Halide Supply." />
							</div>
						</div>
					))}
				</div>
			</Row>

			<Row title="Hero — collage layout, three skins">
				<div className="flex flex-col gap-10">
					{SKINS.map(({ name, Hero }) => (
						<div key={name} className="flex flex-col gap-1.5">
							<span className="text-xs text-muted-foreground">{name}</span>
							<div className="overflow-hidden rounded-lg border">
								<Hero
									layout="collage"
									badge={<Badge variant="secondary">Now shipping</Badge>}
									headline={
										<>
											Objects made to be kept, <span className="text-muted-foreground">not replaced.</span>
										</>
									}
									subcopy="Small-batch goods for people who notice the difference."
									actions={
										<>
											<Button>Shop the collection</Button>
											<Button variant="outline">Our story</Button>
										</>
									}
									media={<BaseArtImage seed="skin-review" kind="product" />}
								/>
							</div>
						</div>
					))}
				</div>
			</Row>
		</div>
	)
}
