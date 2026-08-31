import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

export interface SkeletonListProps {
	/** How many placeholder items (default 3). Match the count you usually render. */
	count?: number
	/** rows: list/table lines · cards: a card grid · stats: a KPI row. */
	shape?: 'rows' | 'cards' | 'stats'
	className?: string
}

/** THE LOADING STATE. Any view that waits on data shows this, not a spinner and never a blank screen:
 *  a skeleton in the SHAPE of the coming content keeps the layout from jumping when the data lands. */
export function SkeletonList({ count = 3, shape = 'rows', className }: SkeletonListProps) {
	const items = Array.from({ length: count })
	if (shape === 'cards') {
		return (
			<div data-block="skeleton-list" className={cn('grid gap-6 sm:grid-cols-2 lg:grid-cols-3', className)}>
				{/* Mirrors MediaCard EXACTLY: media flush to the card edge, text body inset p-4. Padding the
				    image too (the old shape) made the skeleton a different size from the card that replaces
				    it, so the grid jumped on load — the one thing a skeleton exists to prevent. */}
				{items.map((_, i) => (
					<div key={i} className="flex flex-col overflow-hidden rounded-xl border bg-card">
						<Skeleton className="aspect-[4/3] w-full rounded-none" />
						<div className="flex flex-col gap-1.5 p-4">
							<Skeleton className="h-4 w-2/3" />
							<Skeleton className="h-3 w-1/3" />
						</div>
					</div>
				))}
			</div>
		)
	}
	if (shape === 'stats') {
		return (
			<div data-block="skeleton-list" className={cn('grid gap-4 sm:grid-cols-2 xl:grid-cols-4', className)}>
				{items.map((_, i) => (
					<div key={i} className="flex flex-col gap-3 rounded-xl border bg-card p-6">
						<Skeleton className="h-3 w-24" />
						<Skeleton className="h-8 w-32" />
						<Skeleton className="h-3 w-40" />
					</div>
				))}
			</div>
		)
	}
	return (
		<div data-block="skeleton-list" className={cn('flex flex-col divide-y rounded-xl border bg-card', className)}>
			{items.map((_, i) => (
				<div key={i} className="flex items-center gap-4 p-4">
					<Skeleton className="size-10 shrink-0 rounded-lg" />
					<div className="flex flex-1 flex-col gap-2">
						<Skeleton className="h-4 w-1/3" />
						<Skeleton className="h-3 w-1/4" />
					</div>
					<Skeleton className="h-4 w-16" />
				</div>
			))}
		</div>
	)
}
