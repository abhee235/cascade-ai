// Reference solution for --verify: all six iterative rounds implemented (shop, wishlist, search+filter,
// persisted theme, cart fixes, order history). Compact but real; client-side state only.
import { useEffect, useMemo, useState } from 'react'

interface Product {
	id: number
	name: string
	price: number
	blurb: string
	emoji: string
	category: string
}

const PRODUCTS: Product[] = [
	{ id: 1, name: 'Trail Backpack', price: 89.0, blurb: 'Weatherproof 28L pack.', emoji: '🎒', category: 'Gear' },
	{ id: 2, name: 'Steel Bottle', price: 24.5, blurb: 'Cold for 24 hours.', emoji: '🥤', category: 'Gear' },
	{ id: 3, name: 'Camp Lantern', price: 32.0, blurb: '400 lumens, 3 modes.', emoji: '🏮', category: 'Lighting' },
	{ id: 4, name: 'Wool Beanie', price: 19.99, blurb: 'Merino wool.', emoji: '🧢', category: 'Apparel' },
	{ id: 5, name: 'Field Notebook', price: 12.0, blurb: 'Waterproof pages.', emoji: '📓', category: 'Stationery' },
	{ id: 6, name: 'Compass Pro', price: 45.25, blurb: 'Sighting compass.', emoji: '🧭', category: 'Gear' },
]
const CATEGORIES = ['All', ...new Set(PRODUCTS.map((p) => p.category))]
const fmt = (n: number) => `$${n.toFixed(2)}`

interface Order {
	items: { name: string; qty: number; price: number }[]
	total: number
	at: string
}
type View = 'catalog' | 'cart' | 'wishlist' | 'orders' | number // number = product detail id

export default function App() {
	const [view, setView] = useState<View>('catalog')
	const [cart, setCart] = useState<Record<number, number>>({})
	const [wish, setWish] = useState<Set<number>>(new Set())
	const [orders, setOrders] = useState<Order[]>([])
	const [query, setQuery] = useState('')
	const [cat, setCat] = useState('All')
	const [dark, setDark] = useState(() => (localStorage.getItem('theme') ?? 'dark') === 'dark')
	useEffect(() => localStorage.setItem('theme', dark ? 'dark' : 'light'), [dark])

	const count = useMemo(() => Object.values(cart).reduce((a, b) => a + b, 0), [cart])
	const total = useMemo(
		() => Object.entries(cart).reduce((s, [id, q]) => s + (PRODUCTS.find((p) => p.id === Number(id))?.price ?? 0) * q, 0),
		[cart],
	)
	const add = (id: number) => setCart((c) => ({ ...c, [id]: (c[id] ?? 0) + 1 }))
	const setQty = (id: number, qty: number) =>
		setCart((c) => {
			const n = { ...c }
			if (qty <= 0) delete n[id] // fix 1: zero removes the line
			else n[id] = qty
			return n
		})
	const toggleWish = (id: number) =>
		setWish((w) => {
			const n = new Set(w)
			n.has(id) ? n.delete(id) : n.add(id)
			return n
		})

	const shown = PRODUCTS.filter((p) => (cat === 'All' || p.category === cat) && p.name.toLowerCase().includes(query.toLowerCase()))
	const bg = dark ? 'bg-neutral-950 text-neutral-100' : 'bg-neutral-50 text-neutral-900'
	const card = dark ? 'border-neutral-800 bg-neutral-900' : 'border-neutral-200 bg-white'

	return (
		<main className={`min-h-screen ${bg}`}>
			<header className={`flex items-center gap-3 border-b px-6 py-4 ${dark ? 'border-neutral-800' : 'border-neutral-200'}`}>
				<button className="text-xl font-bold" onClick={() => setView('catalog')}>
					Cascade Shop
				</button>
				<span className="flex-1" />
				<button className="rounded-lg px-3 py-2" onClick={() => setDark((d) => !d)}>
					{dark ? '☀️' : '🌙'}
				</button>
				<button className="relative rounded-lg px-3 py-2" onClick={() => setView('orders')}>
					Orders
				</button>
				<button className="relative rounded-lg px-3 py-2" onClick={() => setView('wishlist')}>
					♥ Wishlist {wish.size > 0 && <b>({wish.size})</b>}
				</button>
				<button className="relative rounded-lg px-3 py-2" onClick={() => setView('cart')}>
					🛒 Cart {count > 0 && <b>({count})</b>}
				</button>
			</header>

			{view === 'catalog' && (
				<section className="p-6">
					<div className="mb-4 flex flex-wrap gap-2">
						<input className={`rounded-lg border px-3 py-2 ${card}`} placeholder="Search products…" value={query} onChange={(e) => setQuery(e.target.value)} />
						{CATEGORIES.map((c) => (
							<button key={c} className={`rounded-full border px-3 py-1 ${c === cat ? 'font-bold underline' : ''} ${card}`} onClick={() => setCat(c)}>
								{c}
							</button>
						))}
					</div>
					<div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
						{shown.map((p) => (
							<div key={p.id} className={`rounded-xl border p-5 ${card}`}>
								<button className="absolute" onClick={() => toggleWish(p.id)}>
									{wish.has(p.id) ? '❤️' : '🤍'}
								</button>
								<button className="block w-full text-left" onClick={() => setView(p.id)}>
									<div className="text-5xl">{p.emoji}</div>
									<div className="mt-2 font-semibold">{p.name}</div>
									<div>{fmt(p.price)}</div>
								</button>
								<button className="mt-3 w-full rounded-lg bg-blue-600 py-2 text-white" onClick={() => add(p.id)}>
									Add to cart
								</button>
							</div>
						))}
					</div>
				</section>
			)}

			{typeof view === 'number' &&
				(() => {
					const p = PRODUCTS.find((x) => x.id === view)!
					return (
						<section className="mx-auto max-w-md p-6 text-center">
							<button onClick={() => setView('catalog')}>← Back</button>
							<div className="text-8xl">{p.emoji}</div>
							<h2 className="mt-3 text-2xl font-bold">{p.name}</h2>
							<div>{fmt(p.price)}</div>
							<p className="mt-2 opacity-70">{p.blurb}</p>
							<div className="mt-4 flex gap-2">
								<button className="flex-1 rounded-lg bg-blue-600 py-2 text-white" onClick={() => add(p.id)}>
									Add to cart
								</button>
								<button className={`rounded-lg border px-4 ${card}`} onClick={() => toggleWish(p.id)}>
									{wish.has(p.id) ? '❤️' : '🤍'}
								</button>
							</div>
						</section>
					)
				})()}

			{view === 'wishlist' && (
				<section className="mx-auto max-w-lg p-6">
					<h2 className="text-2xl font-bold">Wishlist</h2>
					{[...wish].map((id) => {
						const p = PRODUCTS.find((x) => x.id === id)!
						return (
							<div key={id} className={`mt-3 flex items-center justify-between rounded-lg border p-3 ${card}`}>
								<span>
									{p.emoji} {p.name} {fmt(p.price)}
								</span>
								<button
									className="rounded-lg bg-blue-600 px-3 py-1 text-white"
									onClick={() => {
										add(id)
										toggleWish(id)
									}}
								>
									Move to cart
								</button>
							</div>
						)
					})}
					{wish.size === 0 && <p className="mt-3 opacity-60">Nothing saved yet.</p>}
				</section>
			)}

			{view === 'cart' && (
				<CartView
					cart={cart}
					total={total}
					setQty={setQty}
					card={card}
					onOrder={(o) => {
						setOrders((os) => [o, ...os])
						setCart({})
					}}
				/>
			)}

			{view === 'orders' && (
				<section className="mx-auto max-w-lg p-6">
					<h2 className="text-2xl font-bold">Orders</h2>
					{orders.length === 0 && <p className="mt-3 opacity-60">No orders yet.</p>}
					{orders.map((o, i) => (
						<details key={i} className={`mt-3 rounded-lg border p-3 ${card}`}>
							<summary>
								{new Date(o.at).toLocaleString()} — {fmt(o.total)}
							</summary>
							{o.items.map((it, j) => (
								<div key={j} className="mt-1 flex justify-between text-sm">
									<span>
										{it.name} × {it.qty}
									</span>
									<span>{fmt(it.price * it.qty)}</span>
								</div>
							))}
						</details>
					))}
				</section>
			)}
		</main>
	)
}

function CartView({
	cart,
	total,
	setQty,
	card,
	onOrder,
}: {
	cart: Record<number, number>
	total: number
	setQty: (id: number, qty: number) => void
	card: string
	onOrder: (o: Order) => void
}) {
	const [checkout, setCheckout] = useState(false)
	const [form, setForm] = useState({ name: '', email: '', address: '' })
	const [error, setError] = useState('')
	const [placed, setPlaced] = useState('')
	const lines = Object.entries(cart).map(([id, qty]) => ({ p: PRODUCTS.find((x) => x.id === Number(id))!, qty }))

	if (placed) return <section className="p-6 text-center text-lg">{placed}</section>

	const submit = (e: React.FormEvent) => {
		e.preventDefault()
		if (!form.name.trim() || !/.+@.+\..+/.test(form.email) || !form.address.trim()) {
			setError('Please fill in a valid name, email, and address.')
			return
		}
		onOrder({ items: lines.map(({ p, qty }) => ({ name: p.name, qty, price: p.price })), total, at: new Date().toISOString() })
		setPlaced(`Order confirmed! Total: ${fmt(total)} — thank you, ${form.name}.`)
	}

	return (
		<section className="mx-auto max-w-lg p-6">
			<h2 className="text-2xl font-bold">Your cart</h2>
			{lines.length === 0 && <p className="mt-3 opacity-60">Cart is empty.</p>}
			{lines.map(({ p, qty }) => (
				<div key={p.id} className={`mt-3 flex items-center justify-between rounded-lg border p-3 ${card}`}>
					<span>
						{p.emoji} {p.name} <span className="opacity-60">{fmt(p.price)}</span>
					</span>
					<span className="flex items-center gap-2">
						<button onClick={() => setQty(p.id, qty - 1)}>−</button>
						<span>{qty}</span>
						<button onClick={() => setQty(p.id, qty + 1)}>+</button>
						<button className="ml-2 text-red-500" onClick={() => setQty(p.id, 0)}>
							Remove
						</button>
					</span>
				</div>
			))}
			{lines.length > 0 && (
				<div className="mt-4 flex justify-between border-t pt-3">
					<span>Order total</span>
					<b>{fmt(total)}</b>
				</div>
			)}
			<button className="mt-4 w-full rounded-lg bg-blue-600 py-2 text-white disabled:opacity-40" disabled={lines.length === 0} onClick={() => setCheckout(true)}>
				Checkout
			</button>
			{checkout && lines.length > 0 && (
				<form className="mt-4 flex flex-col gap-3" onSubmit={submit}>
					<input className={`rounded-lg border px-3 py-2 ${card}`} placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
					<input className={`rounded-lg border px-3 py-2 ${card}`} placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
					<input className={`rounded-lg border px-3 py-2 ${card}`} placeholder="Address" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} required />
					{error && <p className="text-sm text-red-500">{error}</p>}
					<button className="rounded-lg bg-green-600 py-2 text-white" type="submit">
						Place order
					</button>
				</form>
			)}
		</section>
	)
}
