// SOLUTION EXEMPLAR — the state AFTER the restyle turn: the app code is the turn-1 gallery, UNCHANGED.
// Everything the second prompt asked for lives outside this file: src/index.css imports luxe-dark, and
// src/components/blocks carries the sharp skin's bytes. That is the whole point being measured — a
// restyle that needs no app-code edits.

import { Camera } from 'lucide-react'
import { ArtImage } from '@/components/blocks/ArtImage'
import { MediaCard } from '@/components/blocks/MediaCard'
import { NavBar } from '@/components/blocks/NavBar'
import { Section } from '@/components/blocks/Section'

const PRODUCTS = [
	{ id: 'p1', name: 'Portra 400 · 3-pack', price: 38, description: 'The forgiving colour negative that made everyone a portrait shooter.' },
	{ id: 'p2', name: 'HP5 Plus · 5-pack', price: 42, description: 'Push it to 1600 and it just gets more honest.' },
	{ id: 'p3', name: 'K1000 body, serviced', price: 189, description: 'The teaching camera. New seals, clean meter, six-month guarantee.' },
	{ id: 'p4', name: 'F3 body, serviced', price: 420, description: 'The press workhorse — titanium shutter, aperture-priority, forever.' },
]

export default function App() {
	return (
		<div>
			<NavBar
				brand={
					<>
						<Camera className="size-4 text-primary" /> Halide Supply
					</>
				}
			/>
			<Section eyebrow="In stock this week" heading="Film and serviced bodies" description="Small batches, checked by hand.">
				<div className="grid gap-6 sm:grid-cols-2">
					{PRODUCTS.map((p) => (
						<MediaCard
							key={p.id}
							media={<ArtImage seed={p.name} kind="product" />}
							title={p.name}
							meta={p.description}
							aside={<span className="font-semibold tabular-nums">${p.price.toFixed(2)}</span>}
						/>
					))}
				</div>
			</Section>
		</div>
	)
}
