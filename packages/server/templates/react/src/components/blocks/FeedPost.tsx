import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface FeedPostProps {
	/** The avatar slot — an <Avatar> with initials, or an <img>. Sized by the block. */
	avatar: ReactNode
	/** Display name, bold. */
	author: ReactNode
	/** The quiet line beside the name: handle · relative time ("@lena · 2h"). */
	meta?: ReactNode
	/** The post body. Plain text or rich children. */
	children: ReactNode
	/** Optional media under the body — a <Photo>, <ArtImage>, or <img>. Rounded by the block. */
	media?: ReactNode
	/** The action row: like/reply/share as ghost Buttons with counts. Buttons stopPropagation themselves. */
	actions?: ReactNode
	/** Whole-post click target (open the detail view). */
	onClick?: () => void
	className?: string
}

/** ONE POST in a feed. Stack these in a `divide-y` column — never cards floating in a grid: a feed is a
 *  single reading column (max-w-xl), and the divider rhythm is what makes it scannable. */
export function FeedPost({ avatar, author, meta, children, media, actions, onClick, className }: FeedPostProps) {
	return (
		<article data-block="feed-post" onClick={onClick} className={cn('flex gap-3 px-4 py-4', onClick && 'cursor-pointer transition-colors hover:bg-muted/40', className)}>
			<div className="size-10 shrink-0 [&_img]:size-full [&_img]:rounded-full [&_img]:object-cover">{avatar}</div>
			<div className="flex min-w-0 flex-1 flex-col gap-1.5">
				<div className="flex items-baseline gap-2 text-sm">
					<span className="font-semibold">{author}</span>
					{meta ? <span className="truncate text-muted-foreground">{meta}</span> : null}
				</div>
				<div className="text-[0.95rem] leading-relaxed">{children}</div>
				{media ? <div className="mt-1 overflow-hidden rounded-xl border [&_img]:max-h-80 [&_img]:w-full [&_img]:object-cover">{media}</div> : null}
				{actions ? <div className="mt-1 flex items-center gap-1 text-muted-foreground">{actions}</div> : null}
			</div>
		</article>
	)
}
