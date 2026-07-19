import { useEffect, useMemo, useState } from 'react'
import { Heart, Moon, Package, ShoppingCart, Sparkles, Sun } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { NavBar } from '@/components/blocks/NavBar'
import { CartView } from '@/components/CartView'
import { CatalogView } from '@/components/CatalogView'
import { OrdersView } from '@/components/OrdersView'
import { ProductDetail } from '@/components/ProductDetail'
import { WishlistView } from '@/components/WishlistView'
import type { CartLine, Order, Product } from '@/lib/types'

type View = { name: 'catalog' } | { name: 'detail'; product: Product } | { name: 'cart' } | { name: 'wishlist' } | { name: 'orders' }

export default function App() {
	const [view, setView] = useState<View>({ name: 'catalog' })
	const [cart, setCart] = useState<CartLine[]>([])
	const [wishlist, setWishlist] = useState<Set<string>>(new Set())
	const [orders, setOrders] = useState<Order[]>([])
	const [dark, setDark] = useState(() => (localStorage.getItem('theme') ?? 'dark') === 'dark')
	const count = useMemo(() => cart.reduce((s, l) => s + l.qty, 0), [cart])

	useEffect(() => {
		document.documentElement.classList.toggle('dark', dark)
		localStorage.setItem('theme', dark ? 'dark' : 'light')
	}, [dark])

	const add = (p: Product) =>
		setCart((c) => {
			const line = c.find((l) => l.productId === p.id)
			return line ? c.map((l) => (l.productId === p.id ? { ...l, qty: l.qty + 1 } : l)) : [...c, { productId: p.id, qty: 1 }]
		})
	const bump = (id: string, delta: number) =>
		setCart((c) => c.map((l) => (l.productId === id ? { ...l, qty: Math.max(0, l.qty + delta) } : l)).filter((l) => l.qty > 0))
	const toggleWish = (id: string) =>
		setWishlist((w) => {
			const next = new Set(w)
			next.has(id) ? next.delete(id) : next.add(id)
			return next
		})
	const moveToCart = (p: Product) => {
		add(p)
		toggleWish(p.id)
	}
	const placeOrder = (total: number) => {
		setOrders((o) => [{ lines: cart, total, timestamp: Date.now() }, ...o])
		setCart([])
	}

	return (
		<main className="min-h-screen bg-background text-foreground">
			<NavBar
				brand={
					<button type="button" className="flex items-center gap-2" onClick={() => setView({ name: 'catalog' })}>
						<Sparkles className="size-4 text-primary" /> Cascade Shop
					</button>
				}
				actions={
					<>
						<Button variant="ghost" size="icon" aria-label="Toggle theme" onClick={() => setDark((d) => !d)}>
							{dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
						</Button>
						<Button variant="ghost" size="sm" onClick={() => setView({ name: 'orders' })}>
							<Package className="size-4" /> Orders
						</Button>
						<Button variant="ghost" size="sm" onClick={() => setView({ name: 'wishlist' })}>
							<Heart className="size-4" /> Wishlist
							{wishlist.size > 0 ? <Badge variant="secondary" className="ml-1 px-1.5">{wishlist.size}</Badge> : null}
						</Button>
						<Button variant="outline" size="sm" onClick={() => setView({ name: 'cart' })}>
							<ShoppingCart className="size-4" /> Cart
							{count > 0 ? <Badge className="ml-1 px-1.5">{count}</Badge> : null}
						</Button>
					</>
				}
			/>
			{view.name === 'catalog' && <CatalogView wishlist={wishlist} onToggleWish={toggleWish} onOpen={(p) => setView({ name: 'detail', product: p })} onAdd={add} />}
			{view.name === 'detail' && <ProductDetail product={view.product} onBack={() => setView({ name: 'catalog' })} onAdd={add} />}
			{view.name === 'cart' && <CartView cart={cart} onQty={bump} onRemove={(id) => setCart((c) => c.filter((l) => l.productId !== id))} onBrowse={() => setView({ name: 'catalog' })} onOrder={placeOrder} />}
			{view.name === 'wishlist' && <WishlistView wishlist={wishlist} onMoveToCart={moveToCart} onBrowse={() => setView({ name: 'catalog' })} />}
			{view.name === 'orders' && <OrdersView orders={orders} onBrowse={() => setView({ name: 'catalog' })} />}
		</main>
	)
}
