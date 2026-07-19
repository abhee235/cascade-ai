import { Heart } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ArtImage } from '@/components/blocks/ArtImage'
import { EmptyState } from '@/components/blocks/EmptyState'
import { MediaCard } from '@/components/blocks/MediaCard'
import { PageHeader } from '@/components/blocks/PageHeader'
import { PRODUCTS } from '@/lib/data'
import type { Product } from '@/lib/types'

interface Props {
	wishlist: Set<string>
	onMoveToCart: (p: Product) => void
	onBrowse: () => void
}

export function WishlistView({ wishlist, onMoveToCart, onBrowse }: Props) {
	const items = PRODUCTS.filter((p) => wishlist.has(p.id))
	return (
		<div className="mx-auto max-w-6xl px-6 pb-16">
			<PageHeader title="Wishlist" description={items.length ? `${items.length} saved` : undefined} />
			{items.length === 0 ? (
				<EmptyState icon={Heart} title="Nothing saved yet" description="Tap the heart on any product to keep it here." action={<Button variant="outline" onClick={onBrowse}>Browse the collection</Button>} />
			) : (
				<div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
					{items.map((p) => (
						<MediaCard
							key={p.id}
							media={<ArtImage seed={p.name} kind="product" />}
							title={p.name}
							meta={p.category}
							aside={`$${p.price.toFixed(2)}`}
							actions={
								<Button size="sm" onClick={() => onMoveToCart(p)}>
									Move to cart
								</Button>
							}
						/>
					))}
				</div>
			)}
		</div>
	)
}
