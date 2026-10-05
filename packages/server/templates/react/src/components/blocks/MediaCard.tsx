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

/** The grid workhorse: product / recipe / article / listing card with an image top.
 *  Use inside `grid gap-6 sm:grid-cols-2 lg:grid-cols-3`. */
export function MediaCard({ media, title, meta, aside, actions, onClick, className }: MediaCardProps) {
	return (
		<div
			data-block="media-card"
			onClick={onClick}
			className={cn(
				'group flex flex-col overflow-hidden rounded-xl border bg-card text-card-foreground shadow-xs transition-shadow',
				onClick && 'cursor-pointer hover:shadow-md',
				className,
			)}
		>
			<div className="aspect-[4/3] overflow-hidden bg-muted [&>img]:size-full [&>img]:object-cover [&>img]:transition-transform [&>img]:duration-300 group-hover:[&>img]:scale-[1.03] [&>svg]:size-full">
				{media}
			</div>
			<div className="flex flex-1 flex-col gap-1.5 p-4">
				<div className="flex items-start justify-between gap-3">
					<h3 className="font-medium leading-snug">{title}</h3>
					{aside ? <div className="shrink-0 font-semibold">{aside}</div> : null}
				</div>
				{meta ? <div className="text-sm text-muted-foreground">{meta}</div> : null}
				{actions ? <div className="mt-3 flex items-center gap-2">{actions}</div> : null}
			</div>
		</div>
	)
}
