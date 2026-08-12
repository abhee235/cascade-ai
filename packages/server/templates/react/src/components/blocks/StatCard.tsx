import type { ComponentType, ReactNode } from 'react'
import { TrendingDown, TrendingUp } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

export interface StatCardProps {
	label: ReactNode
	/** The number itself, already formatted ("$48,210", "1,204", "99.98%"). */
	value: ReactNode
	/** Period-over-period change as a NUMBER (e.g. 12.4 or -3.1) — rendered as a trend badge, top right. */
	delta?: number
	/** The bold takeaway line under the number ("Strong user retention"). */
	trendLabel?: ReactNode
	/** The quiet second line ("Engagement exceeds targets" / "vs last week"). */
	note?: ReactNode
	icon?: ComponentType<{ className?: string }>
	/** For metrics where DOWN is good (churn, latency, cost) — flips the colour, not the arrow. */
	lowerIsBetter?: boolean
	className?: string
}

/** ONE KPI. A dashboard's top row is 3–4 of these, computed from real data — never hardcoded, and never
 *  without a comparison: a number with nothing to compare it to tells the reader nothing.
 *
 *  The refined treatment (shadcn dashboard-01): the change is a BADGE in the top-right rather than text
 *  under the number, the card carries a faint primary→card wash so the row reads as a set, and a
 *  two-line footer says what the number MEANS before it says what it is measured against. */
export function StatCard({ label, value, delta, trendLabel, note, icon: Icon, lowerIsBetter = false, className }: StatCardProps) {
	const good = delta === undefined ? undefined : lowerIsBetter ? delta < 0 : delta > 0
	const Trend = delta !== undefined && delta < 0 ? TrendingDown : TrendingUp
	return (
		<div
			data-block="stat-card"
			className={cn('flex flex-col gap-3 rounded-xl border bg-gradient-to-t from-primary/5 to-card p-6 shadow-xs dark:from-card', className)}
		>
			<div className="flex items-start justify-between gap-3">
				<div className="flex items-center gap-2 text-sm text-muted-foreground">
					{Icon ? <Icon className="size-4" /> : null}
					{label}
				</div>
				{delta !== undefined ? (
					<Badge variant="outline" className={cn('gap-1 tabular-nums', good ? 'text-primary' : 'text-destructive')}>
						<Trend className="size-3" />
						{delta > 0 ? '+' : ''}
						{delta}%
					</Badge>
				) : null}
			</div>
			<span className="font-serif text-3xl font-semibold tabular-nums tracking-display">{value}</span>
			{trendLabel || note ? (
				<div className="flex flex-col gap-0.5 text-sm">
					{trendLabel ? (
						<span className="flex items-center gap-1.5 font-medium">
							{trendLabel}
							{delta !== undefined ? <Trend className={cn('size-3.5', good ? 'text-primary' : 'text-destructive')} /> : null}
						</span>
					) : null}
					{note ? <span className="text-muted-foreground">{note}</span> : null}
				</div>
			) : null}
		</div>
	)
}
