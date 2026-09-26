// SKIN: sharp — same MediaCardProps, different STRUCTURE: a horizontal row (square thumbnail left, text
// right) instead of the base's stacked card. Flat 2px border, no shadow, no hover zoom — the hover is a
// ground shift. This is what a skin is FOR: a preset can square the corners, but it cannot turn a stacked
// card into a row. Props are frozen by skins/parity.check.ts; data-block stays for designLint/usesBlocks.
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface MediaCardProps {
	/** The image area: an <img src={photo('…')}/>, an <ArtImage>, or any visual. Fills the top. */
	media: ReactNode
	title: ReactNode
	/** Small muted line under the title (category, author, date…). */
	meta?: ReactNode
	/** Right-aligned emphasis slot (price, badge, rating). */
	aside?: ReactNode
	/** Action row (an "Add to cart" button, a link…). */
	actions?: ReactNode
	/** Whole-card click target (detail view). Keeps inner buttons clickable via stopPropagation in caller. */
	onClick?: () => void
	className?: string
}

/** The grid workhorse: product / recipe / article / listing card — sharp skin renders it as a ROW.
 *  Use inside `grid gap-6 sm:grid-cols-2 lg:grid-cols-3`. */
export function MediaCard({ media, title, meta, aside, actions, onClick, className }: MediaCardProps) {
	return (
		<div
			data-block="media-card"
			onClick={onClick}
			className={cn(
				'group flex overflow-hidden border-2 bg-card text-card-foreground transition-colors',
				onClick && 'cursor-pointer hover:bg-muted/40',
				className,
			)}
		>
			<div className="aspect-square w-28 shrink-0 overflow-hidden border-r-2 bg-muted sm:w-32 [&_img]:size-full [&_img]:object-cover [&_svg]:size-full">
				{media}
			</div>
			<div className="flex min-w-0 flex-1 flex-col gap-1 p-4">
				<div className="flex items-start justify-between gap-3">
					<h3 className="font-medium leading-snug">{title}</h3>
					{aside ? <div className="shrink-0 font-semibold tabular-nums">{aside}</div> : null}
				</div>
				{meta ? <div className="text-sm text-muted-foreground">{meta}</div> : null}
				{actions ? <div className="mt-auto flex items-center gap-2 pt-3">{actions}</div> : null}
			</div>
		</div>
	)
}
