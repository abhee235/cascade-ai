import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface PageHeaderProps {
	title: ReactNode
	description?: ReactNode
	/** Right-aligned actions: filters, a primary button, a search input… */
	actions?: ReactNode
	className?: string
}

/** Header for app views (catalog, dashboard, settings…) — NOT for landing pages (use Hero there).
 *  Title + optional description left, actions right. */
export function PageHeader({ title, description, actions, className }: PageHeaderProps) {
	return (
		<div data-block="page-header" className={cn('mx-auto flex max-w-6xl flex-wrap items-end justify-between gap-4 px-6 pb-8 pt-10', className)}>
			<div className="flex max-w-xl flex-col gap-1.5">
				<h1 className="font-serif text-3xl font-semibold tracking-display">{title}</h1>
				{description ? <p className="text-muted-foreground">{description}</p> : null}
			</div>
			{actions ? <div className="flex items-center gap-2">{actions}</div> : null}
		</div>
	)
}
