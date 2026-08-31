// SKIN: sharp — same StatCardProps, flat treatment: no gradient wash, no shadow, a 4px left rule that
// carries the good/bad verdict as COLOR (primary/destructive), uppercase label, mono value. The base
// renders the delta as a Badge; sharp renders it as bare tabular text — structure, not tokens.
import type { ComponentType, ReactNode } from 'react'
import { TrendingDown, TrendingUp } from 'lucide-react'
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

/** ONE KPI — sharp skin: a flat panel whose left rule states the verdict at a glance. */
export function StatCard({ label, value, delta, trendLabel, note, icon: Icon, lowerIsBetter = false, className }: StatCardProps) {
	const good = delta === undefined ? undefined : lowerIsBetter ? delta < 0 : delta > 0
	const Trend = delta !== undefined && delta < 0 ? TrendingDown : TrendingUp
	return (
		<div
			data-block="stat-card"
			className={cn(
				'flex flex-col gap-3 border-2 border-l-4 bg-card p-6',
				good === undefined ? 'border-l-border' : good ? 'border-l-primary' : 'border-l-destructive',
				className,
			)}
		>
			<div className="flex items-start justify-between gap-3">
				<div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
					{Icon ? <Icon className="size-4" /> : null}
					{label}
				</div>
				{delta !== undefined ? (
					<span className={cn('flex items-center gap-1 text-sm font-semibold tabular-nums', good ? 'text-primary' : 'text-destructive')}>
						<Trend className="size-3.5" />
						{delta > 0 ? '+' : ''}
						{delta}%
					</span>
				) : null}
			</div>
			<span className="font-mono text-3xl font-semibold tabular-nums">{value}</span>
			{trendLabel || note ? (
				<div className="flex flex-col gap-0.5 text-sm">
					{trendLabel ? <span className="font-medium">{trendLabel}</span> : null}
					{note ? <span className="text-muted-foreground">{note}</span> : null}
				</div>
			) : null}
		</div>
	)
}
