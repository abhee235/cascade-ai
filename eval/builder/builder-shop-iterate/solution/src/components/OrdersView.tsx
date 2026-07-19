import { useState } from 'react'
import { ChevronDown, Package } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/blocks/EmptyState'
import { PageHeader } from '@/components/blocks/PageHeader'
import { PRODUCTS } from '@/lib/data'
import type { Order } from '@/lib/types'

export function OrdersView({ orders, onBrowse }: { orders: Order[]; onBrowse: () => void }) {
	const [open, setOpen] = useState<number | null>(null)
	return (
		<div className="mx-auto max-w-3xl px-6 pb-16">
			<PageHeader title="Orders" description={orders.length ? `${orders.length} placed` : undefined} />
			{orders.length === 0 ? (
				<EmptyState icon={Package} title="No orders yet" description="When you check out, your orders appear here." action={<Button variant="outline" onClick={onBrowse}>Browse the collection</Button>} />
			) : (
				<div className="flex flex-col gap-3">
					{orders.map((o, i) => (
						<div key={o.timestamp} className="rounded-xl border bg-card">
							<button type="button" className="flex w-full items-center justify-between gap-4 p-4" onClick={() => setOpen(open === i ? null : i)}>
								<span className="text-sm text-muted-foreground">{new Date(o.timestamp).toLocaleString()}</span>
								<span className="flex items-center gap-2 font-semibold">
									${o.total.toFixed(2)} <ChevronDown className={`size-4 transition-transform ${open === i ? 'rotate-180' : ''}`} />
								</span>
							</button>
							{open === i ? (
								<div className="flex flex-col gap-1.5 border-t p-4">
									{o.lines.map((l) => {
										const p = PRODUCTS.find((x) => x.id === l.productId)!
										return (
											<div key={l.productId} className="flex justify-between text-sm">
												<span>{p.name} × {l.qty}</span>
												<span className="text-muted-foreground">${(p.price * l.qty).toFixed(2)}</span>
											</div>
										)
									})}
								</div>
							) : null}
						</div>
					))}
				</div>
			)}
		</div>
	)
}
