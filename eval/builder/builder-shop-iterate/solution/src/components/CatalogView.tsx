import { useMemo, useState } from 'react'
import { Heart } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ArtImage } from '@/components/blocks/ArtImage'
import { EmptyState } from '@/components/blocks/EmptyState'
import { MediaCard } from '@/components/blocks/MediaCard'
import { PageHeader } from '@/components/blocks/PageHeader'
import { PRODUCTS } from '@/lib/data'
import type { Product } from '@/lib/types'

interface Props {
	wishlist: Set<string>
	onToggleWish: (id: string) => void
	onOpen: (p: Product) => void
	onAdd: (p: Product) => void
}

export function CatalogView({ wishlist, onToggleWish, onOpen, onAdd }: Props) {
	const [query, setQuery] = useState('')
	const [category, setCategory] = useState('All')
	const categories = useMemo(() => ['All', ...new Set(PRODUCTS.map((p) => p.category))], [])
	const shown = PRODUCTS.filter((p) => (category === 'All' || p.category === category) && p.name.toLowerCase().includes(query.toLowerCase()))

	return (
		<div>
			<PageHeader title="The collection" description="Small-batch goods, chosen slowly." actions={<Input placeholder="Search products…" value={query} onChange={(e) => setQuery(e.target.value)} className="w-56" />} />
			<div className="mx-auto flex max-w-6xl flex-wrap gap-2 px-6 pb-6">
				{categories.map((c) => (
					<Button key={c} size="sm" variant={c === category ? 'default' : 'outline'} onClick={() => setCategory(c)}>
						{c}
					</Button>
				))}
			</div>
			<div className="mx-auto max-w-6xl px-6 pb-16">
				{shown.length === 0 ? (
					<EmptyState title="No products match" description="Try a different search or category." action={<Button variant="outline" onClick={() => { setQuery(''); setCategory('All') }}>Clear filters</Button>} />
				) : (
					<div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
						{shown.map((p) => (
							<MediaCard
								key={p.id}
								media={
									<div className="relative size-full">
										<ArtImage seed={p.name} kind="product" />
										<Button
											variant="secondary"
											size="icon-sm"
											aria-label="Toggle wishlist"
											className="absolute right-2 top-2"
											onClick={(e) => {
												e.stopPropagation()
												onToggleWish(p.id)
											}}
										>
											<Heart className={wishlist.has(p.id) ? 'size-4 fill-primary text-primary' : 'size-4'} />
										</Button>
									</div>
								}
								title={p.name}
								meta={p.category}
								aside={`$${p.price.toFixed(2)}`}
								actions={
									<Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); onAdd(p) }}>
										Add to cart
									</Button>
								}
								onClick={() => onOpen(p)}
							/>
						))}
					</div>
				)}
			</div>
		</div>
	)
}
