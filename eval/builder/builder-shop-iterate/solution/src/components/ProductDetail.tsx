import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ArtImage } from '@/components/blocks/ArtImage'
import type { Product } from '@/lib/types'

export function ProductDetail({ product, onBack, onAdd }: { product: Product; onBack: () => void; onAdd: (p: Product) => void }) {
	return (
		<div className="mx-auto grid max-w-6xl items-start gap-10 px-6 py-10 md:grid-cols-2">
			<div className="overflow-hidden rounded-xl shadow-md">
				<ArtImage seed={product.name} kind="product" className="aspect-square" />
			</div>
			<div className="flex flex-col gap-4">
				<Button variant="ghost" size="sm" className="w-fit" onClick={onBack}>
					<ArrowLeft className="size-4" /> Back to catalog
				</Button>
				<Badge variant="secondary">{product.category}</Badge>
				<h1 className="font-serif text-3xl font-semibold tracking-tight">{product.name}</h1>
				<p className="text-2xl font-semibold">${product.price.toFixed(2)}</p>
				<p className="text-muted-foreground">{product.description}</p>
				<Button size="lg" className="w-fit" onClick={() => onAdd(product)}>
					Add to cart
				</Button>
			</div>
		</div>
	)
}
