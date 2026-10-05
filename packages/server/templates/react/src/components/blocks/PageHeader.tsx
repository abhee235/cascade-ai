import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface PageHeaderProps {
	title: ReactNode
	description?: ReactNode
	/** Right-aligned actions: filters, a primary button, a search input… */
	actions?: ReactNode
	className?: string
}

/** The title ROW of an app view (catalog, dashboard, settings…) — NOT a band, and NOT for landing pages (use
 *  Hero there). Put it as the FIRST child of the view's first Section (or of AppShell's content), which owns
 *  the padding and the container; it used to carry its own (pt-10 pb-8) and stack on the Section's.
 *  Title + optional description left, actions right. */
export function PageHeader({ title, description, actions, className }: PageHeaderProps) {
	return (
		<div data-block="page-header" className={cn('mb-8 flex flex-wrap items-end justify-between gap-4', className)}>
			<div className="flex max-w-xl flex-col gap-1.5">
				<h1 className="font-serif text-3xl font-semibold tracking-display">{title}</h1>
				{description ? <p className="text-muted-foreground">{description}</p> : null}
			</div>
			{actions ? <div className="flex items-center gap-2">{actions}</div> : null}
		</div>
	)
}
