import type { ComponentType, ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface EmptyStateProps {
	/** A lucide icon, e.g. `ShoppingCart`. */
	icon?: ComponentType<{ className?: string }>
	title: string
	description?: ReactNode
	/** One CTA that leads somewhere useful (never leave a dead end). */
	action?: ReactNode
	className?: string
}

/** What a list shows when it has nothing — REQUIRED for every list view (cart, results, orders…).
 *  Centered, quiet, with one way forward. */
export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
	return (
		<div data-block="empty-state" className={cn('flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed px-6 py-16 text-center', className)}>
			{Icon ? (
				<span className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
					<Icon className="size-6" />
				</span>
			) : null}
			<h3 className="font-medium">{title}</h3>
			{description ? <p className="max-w-sm text-sm text-muted-foreground">{description}</p> : null}
			{action ? <div className="mt-2">{action}</div> : null}
		</div>
	)
}
