import { Button } from '@/components/ui/button'
import { ArtImage } from '@/components/blocks/ArtImage'
import { MediaCard } from '@/components/blocks/MediaCard'
import { PageHeader } from '@/components/blocks/PageHeader'
import { PRODUCTS } from '@/lib/data'
import type { Product } from '@/lib/types'

export function CatalogView({ onOpen, onAdd }: { onOpen: (p: Product) => void; onAdd: (p: Product) => void }) {
	return (
		<div>
			<PageHeader title="The collection" description="Small-batch goods, chosen slowly." />
			<div className="mx-auto grid max-w-6xl gap-6 px-6 pb-16 sm:grid-cols-2 lg:grid-cols-3">
				{PRODUCTS.map((p) => (
					<MediaCard
						key={p.id}
						media={<ArtImage seed={p.name} kind="product" />}
						title={p.name}
						meta={p.description}
						aside={`$${p.price.toFixed(2)}`}
						actions={
							<Button
								size="sm"
								variant="outline"
								onClick={(e) => {
									e.stopPropagation()
									onAdd(p)
								}}
							>
								Add to cart
							</Button>
						}
						onClick={() => onOpen(p)}
					/>
				))}
			</div>
		</div>
	)
}
