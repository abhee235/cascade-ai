import type { ReactNode } from 'react'
import { Minus, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export interface CartRowProps {
	/** Thumbnail: an <img>, a <Photo>, or an <ArtImage> — never an empty box. */
	media?: ReactNode
	title: ReactNode
	/** The per-unit price, formatted (e.g. "$29.00"). */
	unitPrice: ReactNode
	meta?: ReactNode
	quantity: number
	/** Called with the DELTA (+1 / −1). Clamp at 1 in your handler, or pass onRemove for zero. */
	onQuantityChange?: (delta: number) => void
	onRemove?: () => void
	/** Line total (unit × quantity), formatted. Compute it — never store it. */
	lineTotal?: ReactNode
	className?: string
}

/** ONE CART LINE — thumbnail, title, quantity stepper, remove, line total. The stepper and the remove
 *  control are what make a cart feel real; a static list of names reads as a receipt, not a cart.
 *  On a phone the controls drop under the title: in one row the line was ~348 px of fixed parts, and a cart
 *  in a padded two-column layout overflowed a 390 px screen by 70–117 px (measured, ADR-086 P1). */
export function CartRow({ media, title, unitPrice, meta, quantity, onQuantityChange, onRemove, lineTotal, className }: CartRowProps) {
	return (
		<div data-block="cart-row" className={cn('flex items-center gap-4 border-b py-4 last:border-b-0', className)}>
			{media ? <div className="size-16 shrink-0 overflow-hidden rounded-lg border bg-muted [&>img]:size-full [&>img]:object-cover [&>svg]:size-full">{media}</div> : null}
			<div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<span className="truncate font-medium">{title}</span>
					{meta ? <span className="text-sm text-muted-foreground">{meta}</span> : null}
					<span className="text-sm text-muted-foreground">{unitPrice} each</span>
				</div>
				<div className="flex items-center gap-4">
					<div className="flex items-center gap-1.5">
						<Button variant="outline" size="icon-sm" aria-label="Decrease quantity" onClick={() => onQuantityChange?.(-1)}>
							<Minus className="size-3.5" />
						</Button>
						<span className="w-8 text-center text-sm tabular-nums">{quantity}</span>
						<Button variant="outline" size="icon-sm" aria-label="Increase quantity" onClick={() => onQuantityChange?.(1)}>
							<Plus className="size-3.5" />
						</Button>
					</div>
					{lineTotal ? <span className="ml-auto text-right font-medium tabular-nums sm:w-20">{lineTotal}</span> : null}
					{onRemove ? (
						<Button variant="ghost" size="icon-sm" aria-label={`Remove ${typeof title === 'string' ? title : 'item'}`} onClick={onRemove}>
							<X className="size-4" />
						</Button>
					) : null}
				</div>
			</div>
		</div>
	)
}
