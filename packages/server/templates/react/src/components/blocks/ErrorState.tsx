import type { ComponentType, ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface ErrorStateProps {
	/** A lucide icon — default is a triangle-alert look. Pass `SearchX` for a 404, `WifiOff` for offline. */
	icon?: ComponentType<{ className?: string }>
	/** A big quiet number/word above the title: "404", "500". Omit for inline failures. */
	code?: string
	title: string
	/** What went wrong in ONE plain sentence. Never a stack trace, never "Error: undefined". */
	description?: ReactNode
	/** The way out — "Try again", "Back to dashboard". A dead end with no action is the bug. */
	action?: ReactNode
	className?: string
}

/** SOMETHING FAILED — the sibling of EmptyState, and NOT the same thing.
 *  EmptyState = the request worked and there is nothing to show (an empty cart, no results yet):
 *  dashed border, muted icon, invitation to go add something.
 *  ErrorState = the request did NOT work (fetch failed, route missing, save rejected): solid border,
 *  destructive icon, and an action that RETRIES or navigates away. Showing "no items" when a load
 *  actually failed is a lie the user acts on — that is why these are two blocks. */
export function ErrorState({ icon: Icon, code, title, description, action, className }: ErrorStateProps) {
	return (
		<div
			role="alert"
			data-block="error-state"
			className={cn('flex flex-col items-center justify-center gap-3 rounded-xl border bg-card px-6 py-16 text-center', className)}
		>
			{code ? <span className="font-serif text-5xl font-semibold tabular-nums tracking-display text-muted-foreground/50">{code}</span> : null}
			{Icon ? (
				<span className="flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
					<Icon className="size-6" />
				</span>
			) : null}
			<h2 className="font-serif text-lg font-semibold tracking-display">{title}</h2>
			{description ? <p className="max-w-sm text-sm text-muted-foreground">{description}</p> : null}
			{action ? <div className="mt-2">{action}</div> : null}
		</div>
	)
}
