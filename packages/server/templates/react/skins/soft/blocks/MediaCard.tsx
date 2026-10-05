// SKIN: soft — same MediaCardProps, airy treatment: no border at all (a layered shadow does the lifting),
// 2xl corners, the media inset in a padded frame so the photo floats inside the card rather than bleeding
// to its edges. Structure vs base: inset media + pillowed geometry; vs sharp: the exact opposite pole.
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

/** The grid workhorse — soft skin: a floating, borderless card with the photo inset like a print in a mat.
 *  Use inside `grid gap-6 sm:grid-cols-2 lg:grid-cols-3`. */
export function MediaCard({ media, title, meta, aside, actions, onClick, className }: MediaCardProps) {
	return (
		<div
			data-block="media-card"
			onClick={onClick}
			className={cn(
				'group flex flex-col rounded-2xl bg-card p-3 text-card-foreground shadow-md shadow-foreground/5 transition-shadow',
				onClick && 'cursor-pointer hover:shadow-lg hover:shadow-foreground/10',
				className,
			)}
		>
			<div className="aspect-[4/3] overflow-hidden rounded-xl bg-muted [&>img]:size-full [&>img]:object-cover [&>img]:transition-transform [&>img]:duration-300 group-hover:[&>img]:scale-[1.03] [&>svg]:size-full">
				{media}
			</div>
			<div className="flex flex-1 flex-col gap-1.5 p-4 pb-3">
				<div className="flex items-start justify-between gap-3">
					<h3 className="font-medium leading-snug">{title}</h3>
					{aside ? <div className="shrink-0 rounded-full bg-muted px-3 py-1 text-sm font-semibold tabular-nums">{aside}</div> : null}
				</div>
				{meta ? <div className="text-sm text-muted-foreground">{meta}</div> : null}
				{actions ? <div className="mt-3 flex items-center gap-2">{actions}</div> : null}
			</div>
		</div>
	)
}
