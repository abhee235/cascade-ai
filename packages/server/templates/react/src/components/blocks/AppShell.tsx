import type { ComponentType, ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface AppNavItem {
	label: ReactNode
	icon?: ComponentType<{ className?: string }>
	active?: boolean
	onClick?: () => void
	/** A count or status pill on the right of the row. */
	badge?: ReactNode
}

export interface AppNavGroup {
	heading?: string
	items: AppNavItem[]
}

export interface AppShellProps {
	brand: ReactNode
	groups: AppNavGroup[]
	/** Bottom-of-sidebar slot: the signed-in user, a plan badge, a sign-out control. */
	user?: ReactNode
	/** Sticky top bar content — the current page title or a breadcrumb. */
	header?: ReactNode
	/** Right side of the top bar: search, notifications, a primary action. */
	headerActions?: ReactNode
	children: ReactNode
	className?: string
}

/** THE APP CHROME — sidebar + sticky header + content well. Every internal (signed-in) view of a
 *  dashboard, admin, or SaaS app lives inside ONE of these; a bare centered column reads as a marketing
 *  page, not a product. The content well sits on `bg-muted/40` so cards read as raised surfaces.
 *
 *  Responsive: the sidebar is a fixed rail from `lg`, and below that the nav collapses to a scrollable
 *  strip under the header — no drawer state to manage, which keeps this a layout block, not a widget. */
export function AppShell({ brand, groups, user, header, headerActions, children, className }: AppShellProps) {
	const navRow = (item: AppNavItem, i: number) => (
		<button
			key={i}
			type="button"
			onClick={item.onClick}
			className={cn(
				'flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors',
				item.active ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
			)}
		>
			{item.icon ? <item.icon className="size-4 shrink-0" /> : null}
			<span className="truncate">{item.label}</span>
			{item.badge ? <span className="ml-auto">{item.badge}</span> : null}
		</button>
	)

	return (
		<div data-block="app-shell" className={cn('flex min-h-screen bg-muted/40', className)}>
			<aside className="hidden w-64 shrink-0 flex-col border-r bg-card lg:flex">
				<div className="flex h-nav items-center gap-2.5 border-b px-5 font-serif text-lg font-semibold tracking-display">{brand}</div>
				<nav className="flex flex-1 flex-col gap-6 overflow-y-auto p-3">
					{groups.map((group, gi) => (
						<div key={gi} className="flex flex-col gap-1">
							{group.heading ? <span className="px-3 pb-1 text-xs font-medium uppercase tracking-widest text-muted-foreground">{group.heading}</span> : null}
							{group.items.map(navRow)}
						</div>
					))}
				</nav>
				{user ? <div className="border-t p-3">{user}</div> : null}
			</aside>

			<div className="flex min-w-0 flex-1 flex-col">
				<header className="sticky top-0 z-10 flex h-nav items-center gap-4 border-b bg-card/80 px-4 backdrop-blur lg:px-6">
					<div className="flex items-center gap-2.5 font-serif text-base font-semibold tracking-display lg:hidden">{brand}</div>
					<div className="min-w-0 flex-1 truncate text-sm font-medium">{header}</div>
					{headerActions ? <div className="flex items-center gap-2">{headerActions}</div> : null}
				</header>
				<div className="flex gap-1 overflow-x-auto border-b bg-card px-3 py-2 lg:hidden">
					{groups.flatMap((g) => g.items).map((item, i) => (
						<button
							key={i}
							type="button"
							onClick={item.onClick}
							className={cn('shrink-0 rounded-md px-3 py-1.5 text-sm transition-colors', item.active ? 'bg-accent text-accent-foreground' : 'text-muted-foreground')}
						>
							{item.label}
						</button>
					))}
				</div>
				<main className="flex-1 p-4 lg:p-6">{children}</main>
			</div>
		</div>
	)
}
