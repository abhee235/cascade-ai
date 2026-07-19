import { useState } from 'react'
import { Minus, Plus, ShoppingCart } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { EmptyState } from '@/components/blocks/EmptyState'
import { PageHeader } from '@/components/blocks/PageHeader'
import { PRODUCTS } from '@/lib/data'
import type { CartLine } from '@/lib/types'

interface Props {
	cart: CartLine[]
	onQty: (id: string, delta: number) => void
	onRemove: (id: string) => void
	onBrowse: () => void
}

export function CartView({ cart, onQty, onRemove, onBrowse }: Props) {
	const [form, setForm] = useState({ name: '', email: '', address: '' })
	const [checkingOut, setCheckingOut] = useState(false)
	const [confirmed, setConfirmed] = useState<number | null>(null)
	const lines = cart.map((l) => ({ ...l, product: PRODUCTS.find((p) => p.id === l.productId)! }))
	const total = lines.reduce((s, l) => s + l.product.price * l.qty, 0)
	const formValid = form.name.trim() && /\S+@\S+\.\S+/.test(form.email) && form.address.trim()

	if (confirmed !== null)
		return (
			<div className="mx-auto max-w-xl px-6 py-16">
				<EmptyState title="Order confirmed" description={`Thank you! Your total was $${confirmed.toFixed(2)}. A receipt is on its way.`} action={<Button onClick={onBrowse}>Keep browsing</Button>} />
			</div>
		)

	return (
		<div className="mx-auto max-w-3xl px-6 pb-16">
			<PageHeader title="Your cart" description={lines.length ? `${lines.length} line${lines.length > 1 ? 's' : ''}` : undefined} />
			{lines.length === 0 ? (
				<EmptyState icon={ShoppingCart} title="Your cart is empty" description="Find something you'll keep." action={<Button variant="outline" onClick={onBrowse}>Browse the collection</Button>} />
			) : (
				<div className="flex flex-col gap-4">
					{lines.map((l) => (
						<div key={l.productId} className="flex items-center justify-between gap-4 rounded-xl border bg-card p-4">
							<div className="flex flex-col">
								<span className="font-medium">{l.product.name}</span>
								<span className="text-sm text-muted-foreground">${l.product.price.toFixed(2)} each</span>
							</div>
							<div className="flex items-center gap-2">
								<Button variant="outline" size="icon-sm" aria-label="Decrease" onClick={() => onQty(l.productId, -1)}><Minus className="size-3.5" /></Button>
								<span className="w-6 text-center text-sm">{l.qty}</span>
								<Button variant="outline" size="icon-sm" aria-label="Increase" onClick={() => onQty(l.productId, 1)}><Plus className="size-3.5" /></Button>
								<Button variant="ghost" size="sm" className="text-destructive" onClick={() => onRemove(l.productId)}>Remove</Button>
							</div>
						</div>
					))}
					<div className="flex items-center justify-between border-t pt-4">
						<span className="text-muted-foreground">Order total</span>
						<span className="font-serif text-2xl font-semibold">${total.toFixed(2)}</span>
					</div>
					{!checkingOut ? (
						<Button size="lg" className="self-end" onClick={() => setCheckingOut(true)}>Checkout</Button>
					) : (
						<form
							className="flex flex-col gap-3 rounded-xl border bg-card p-5"
							onSubmit={(e) => {
								e.preventDefault()
								if (formValid) setConfirmed(total)
							}}
						>
							<Label htmlFor="name">Name</Label>
							<Input id="name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
							<Label htmlFor="email">Email</Label>
							<Input id="email" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
							<Label htmlFor="address">Address</Label>
							<Input id="address" required value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
							<Button type="submit" disabled={!formValid} className="mt-2 self-end">Place order — ${total.toFixed(2)}</Button>
						</form>
					)}
				</div>
			)}
		</div>
	)
}
