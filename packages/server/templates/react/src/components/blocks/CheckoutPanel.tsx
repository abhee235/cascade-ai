import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface OrderLine {
	label: ReactNode
	value: ReactNode
	/** Renders muted — for tax, shipping, discounts. */
	muted?: boolean
}

export interface CheckoutPanelProps {
	/** The order summary rows above the total (subtotal, shipping, tax…). */
	lines: OrderLine[]
	total: ReactNode
	totalLabel?: ReactNode
	/** The form fields — compose Label+Input pairs per the forms skill; validate ON SUBMIT. */
	children?: ReactNode
	/** The submit control: ONE primary <Button type="submit">. */
	action?: ReactNode
	/** Shown after a successful submit instead of the form (pass a confirmation message). */
	confirmation?: ReactNode
	className?: string
}

/** CHECKOUT — the order summary beside (or above) the details form. Money is right-aligned and
 *  tabular-nums so the column reads as a column; the total is visually separated from its parts. */
export function CheckoutPanel({ lines, total, totalLabel = 'Total', children, action, confirmation, className }: CheckoutPanelProps) {
	return (
		<div data-block="checkout-panel" className={cn('grid grid-cols-1 gap-6 md:grid-cols-[1fr_20rem] md:items-start', className)}>
			<div className="flex flex-col gap-4 rounded-xl border bg-card p-6">
				{confirmation ?? children}
				{!confirmation && action ? <div className="mt-2 flex justify-end">{action}</div> : null}
			</div>
			<aside className="flex flex-col gap-3 rounded-xl border bg-muted/40 p-6">
				{lines.map((line, i) => (
					<div key={i} className={cn('flex items-center justify-between text-sm', line.muted && 'text-muted-foreground')}>
						<span>{line.label}</span>
						<span className="tabular-nums">{line.value}</span>
					</div>
				))}
				<div className="mt-2 flex items-baseline justify-between border-t pt-3">
					<span className="text-sm font-medium">{totalLabel}</span>
					<span className="font-serif text-2xl font-semibold tabular-nums tracking-display">{total}</span>
				</div>
			</aside>
		</div>
	)
}
