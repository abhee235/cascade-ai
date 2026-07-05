// Reference solution for the --verify invariant (seed must FAIL the check, this must PASS).
// Deliberately compact but REAL: catalog grid, detail view, cart with quantity/remove/total,
// checkout form with validation, header badge — all client-side state, no new deps.
import { useMemo, useState } from 'react'

interface Product {
	id: number
	name: string
	price: number
	blurb: string
	emoji: string
}

const PRODUCTS: Product[] = [
	{ id: 1, name: 'Trail Backpack', price: 89.0, blurb: 'Weatherproof 28L pack for day hikes.', emoji: '🎒' },
	{ id: 2, name: 'Steel Bottle', price: 24.5, blurb: 'Keeps drinks cold for 24 hours.', emoji: '🥤' },
	{ id: 3, name: 'Camp Lantern', price: 32.0, blurb: 'Rechargeable, 400 lumens, 3 modes.', emoji: '🏮' },
	{ id: 4, name: 'Wool Beanie', price: 19.99, blurb: 'Merino wool, one size fits most.', emoji: '🧢' },
	{ id: 5, name: 'Field Notebook', price: 12.0, blurb: 'Waterproof pages, pocket sized.', emoji: '📓' },
	{ id: 6, name: 'Compass Pro', price: 45.25, blurb: 'Sighting compass with declination.', emoji: '🧭' },
]

type View = { kind: 'catalog' } | { kind: 'detail'; id: number } | { kind: 'cart' }

export default function App() {
	const [view, setView] = useState<View>({ kind: 'catalog' })
	const [cart, setCart] = useState<Record<number, number>>({})
	const [placed, setPlaced] = useState<string | null>(null)

	const count = useMemo(() => Object.values(cart).reduce((a, b) => a + b, 0), [cart])
	const total = useMemo(
		() => Object.entries(cart).reduce((sum, [id, qty]) => sum + (PRODUCTS.find((p) => p.id === Number(id))?.price ?? 0) * qty, 0),
		[cart],
	)
	const add = (id: number) => setCart((c) => ({ ...c, [id]: (c[id] ?? 0) + 1 }))
	const setQty = (id: number, qty: number) =>
		setCart((c) => {
			const next = { ...c }
			if (qty <= 0) delete next[id]
			else next[id] = qty
			return next
		})

	return (
		<main className="min-h-screen bg-neutral-950 text-neutral-100">
			<header className="flex items-center justify-between border-b border-neutral-800 px-6 py-4">
				<button className="text-xl font-bold tracking-tight" onClick={() => setView({ kind: 'catalog' })}>
					Cascade Shop
				</button>
				<button className="relative rounded-lg bg-neutral-800 px-4 py-2 hover:bg-neutral-700" onClick={() => setView({ kind: 'cart' })}>
					🛒 Cart
					{count > 0 && <span className="absolute -right-2 -top-2 rounded-full bg-blue-600 px-2 py-0.5 text-xs">{count}</span>}
				</button>
			</header>

			{view.kind === 'catalog' && (
				<section className="grid grid-cols-1 gap-4 p-6 sm:grid-cols-2 lg:grid-cols-3">
					{PRODUCTS.map((p) => (
						<div key={p.id} className="rounded-xl border border-neutral-800 bg-neutral-900 p-5">
							<button className="block w-full text-left" onClick={() => setView({ kind: 'detail', id: p.id })}>
								<div className="text-5xl">{p.emoji}</div>
								<div className="mt-2 font-semibold">{p.name}</div>
								<div className="text-neutral-400">${p.price.toFixed(2)}</div>
							</button>
							<button className="mt-3 w-full rounded-lg bg-blue-600 py-2 font-medium hover:bg-blue-500" onClick={() => add(p.id)}>
								Add to cart
							</button>
						</div>
					))}
				</section>
			)}

			{view.kind === 'detail' &&
				(() => {
					const p = PRODUCTS.find((x) => x.id === view.id)!
					return (
						<section className="mx-auto max-w-md p-6 text-center">
							<button className="mb-4 text-sm text-neutral-400 hover:text-neutral-200" onClick={() => setView({ kind: 'catalog' })}>
								← Back to catalog
							</button>
							<div className="text-8xl">{p.emoji}</div>
							<h2 className="mt-4 text-2xl font-bold">{p.name}</h2>
							<div className="mt-1 text-lg text-neutral-300">${p.price.toFixed(2)}</div>
							<p className="mt-3 text-neutral-400">{p.blurb}</p>
							<button className="mt-5 w-full rounded-lg bg-blue-600 py-2 font-medium hover:bg-blue-500" onClick={() => add(p.id)}>
								Add to cart
							</button>
						</section>
					)
				})()}

			{view.kind === 'cart' && <Cart cart={cart} total={total} setQty={setQty} placed={placed} onPlace={setPlaced} />}
		</main>
	)
}

function Cart({
	cart,
	total,
	setQty,
	placed,
	onPlace,
}: {
	cart: Record<number, number>
	total: number
	setQty: (id: number, qty: number) => void
	placed: string | null
	onPlace: (msg: string) => void
}) {
	const [checkout, setCheckout] = useState(false)
	const [form, setForm] = useState({ name: '', email: '', address: '' })
	const [error, setError] = useState('')
	const lines = Object.entries(cart).map(([id, qty]) => ({ p: PRODUCTS.find((x) => x.id === Number(id))!, qty }))

	if (placed) return <section className="p-6 text-center text-lg">{placed}</section>

	const submit = (e: React.FormEvent) => {
		e.preventDefault()
		if (!form.name.trim() || !/.+@.+\..+/.test(form.email) || !form.address.trim()) {
			setError('Please fill in a valid name, email, and address.')
			return
		}
		onPlace(`Order confirmed! Total: $${total.toFixed(2)} — thank you, ${form.name}.`)
	}

	return (
		<section className="mx-auto max-w-lg p-6">
			<h2 className="text-2xl font-bold">Your cart</h2>
			{lines.length === 0 && <p className="mt-3 text-neutral-400">Cart is empty.</p>}
			{lines.map(({ p, qty }) => (
				<div key={p.id} className="mt-3 flex items-center justify-between rounded-lg border border-neutral-800 p-3">
					<div>
						{p.emoji} {p.name} <span className="text-neutral-400">${p.price.toFixed(2)}</span>
					</div>
					<div className="flex items-center gap-2">
						<button className="rounded bg-neutral-800 px-2" onClick={() => setQty(p.id, qty - 1)}>
							−
						</button>
						<span>{qty}</span>
						<button className="rounded bg-neutral-800 px-2" onClick={() => setQty(p.id, qty + 1)}>
							+
						</button>
						<button className="ml-2 rounded bg-red-900/60 px-2 text-sm hover:bg-red-800" onClick={() => setQty(p.id, 0)}>
							Remove
						</button>
					</div>
				</div>
			))}
			{lines.length > 0 && (
				<div className="mt-4 flex items-center justify-between border-t border-neutral-800 pt-4">
					<span className="text-neutral-300">Order total</span>
					<span className="text-xl font-bold">${total.toFixed(2)}</span>
				</div>
			)}
			{lines.length > 0 && !checkout && (
				<button className="mt-4 w-full rounded-lg bg-blue-600 py-2 font-medium hover:bg-blue-500" onClick={() => setCheckout(true)}>
					Checkout
				</button>
			)}
			{checkout && (
				<form className="mt-5 flex flex-col gap-3" onSubmit={submit}>
					<input className="rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2" placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
					<input className="rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2" placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
					<input className="rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2" placeholder="Address" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} required />
					{error && <p className="text-sm text-red-400">{error}</p>}
					<button className="rounded-lg bg-green-600 py-2 font-medium hover:bg-green-500" type="submit">
						Place order
					</button>
				</form>
			)}
		</section>
	)
}
