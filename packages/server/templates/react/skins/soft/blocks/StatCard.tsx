// SKIN: soft — same StatCardProps. Borderless pillow card; the icon gets a tinted circular chip, the
// delta rides in a filled pill, and the whole card leans on shadow instead of line-work.
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

/** ONE KPI — soft skin: a floating pillow with a chip icon and a pill delta. */
export function StatCard({ label, value, delta, trendLabel, note, icon: Icon, lowerIsBetter = false, className }: StatCardProps) {
	const good = delta === undefined ? undefined : lowerIsBetter ? delta < 0 : delta > 0
	const Trend = delta !== undefined && delta < 0 ? TrendingDown : TrendingUp
	return (
		<div data-block="stat-card" className={cn('flex flex-col gap-3 rounded-2xl bg-card p-6 shadow-md shadow-foreground/5', className)}>
			<div className="flex items-start justify-between gap-3">
				<div className="flex items-center gap-2.5 text-sm text-muted-foreground">
					{Icon ? (
						<span className="flex size-8 items-center justify-center rounded-full bg-primary/10 text-primary">
							<Icon className="size-4" />
						</span>
					) : null}
					{label}
				</div>
				{delta !== undefined ? (
					<span className={cn('flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold tabular-nums', good ? 'bg-primary/10 text-primary' : 'bg-destructive/10 text-destructive')}>
						<Trend className="size-3" />
						{delta > 0 ? '+' : ''}
						{delta}%
					</span>
				) : null}
			</div>
			<span className="font-serif text-3xl font-semibold tabular-nums tracking-display">{value}</span>
			{trendLabel || note ? (
				<div className="flex flex-col gap-0.5 text-sm">
					{trendLabel ? <span className="font-medium">{trendLabel}</span> : null}
					{note ? <span className="text-muted-foreground">{note}</span> : null}
				</div>
			) : null}
		</div>
	)
}
