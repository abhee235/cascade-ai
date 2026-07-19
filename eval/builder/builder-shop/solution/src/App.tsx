import { useMemo, useState } from 'react'
import { ShoppingCart, Sparkles } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { NavBar } from '@/components/blocks/NavBar'
import { CartView } from '@/components/CartView'
import { CatalogView } from '@/components/CatalogView'
import { ProductDetail } from '@/components/ProductDetail'
import type { CartLine, Product } from '@/lib/types'

type View = { name: 'catalog' } | { name: 'detail'; product: Product } | { name: 'cart' }

export default function App() {
	const [view, setView] = useState<View>({ name: 'catalog' })
	const [cart, setCart] = useState<CartLine[]>([])
	const count = useMemo(() => cart.reduce((s, l) => s + l.qty, 0), [cart])

	const add = (p: Product) =>
		setCart((c) => {
			const line = c.find((l) => l.productId === p.id)
			return line ? c.map((l) => (l.productId === p.id ? { ...l, qty: l.qty + 1 } : l)) : [...c, { productId: p.id, qty: 1 }]
		})
	const bump = (id: string, delta: number) =>
		setCart((c) => c.map((l) => (l.productId === id ? { ...l, qty: Math.max(0, l.qty + delta) } : l)).filter((l) => l.qty > 0))
	const remove = (id: string) => setCart((c) => c.filter((l) => l.productId !== id))

	return (
		<main className="min-h-screen bg-background text-foreground">
			<NavBar
				brand={
					<button type="button" className="flex items-center gap-2" onClick={() => setView({ name: 'catalog' })}>
						<Sparkles className="size-4 text-primary" /> Cascade Shop
					</button>
				}
				actions={
					<Button variant="outline" size="sm" onClick={() => setView({ name: 'cart' })}>
						<ShoppingCart className="size-4" /> Cart
						{count > 0 ? <Badge className="ml-1 px-1.5">{count}</Badge> : null}
					</Button>
				}
			/>
			{view.name === 'catalog' && <CatalogView onOpen={(p) => setView({ name: 'detail', product: p })} onAdd={add} />}
			{view.name === 'detail' && <ProductDetail product={view.product} onBack={() => setView({ name: 'catalog' })} onAdd={add} />}
			{view.name === 'cart' && <CartView cart={cart} onQty={bump} onRemove={remove} onBrowse={() => setView({ name: 'catalog' })} />}
		</main>
	)
}
