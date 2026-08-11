import type { ComponentType, ReactNode } from 'react'
import { ArrowDownRight, ArrowUpRight } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface StatCardProps {
	label: ReactNode
	/** The number itself, already formatted ("$48,210", "1,204", "99.98%"). */
	value: ReactNode
	/** Period-over-period change as a NUMBER (e.g. 12.4 or -3.1) — the block renders sign, arrow, colour. */
	delta?: number
	/** What the delta is measured against ("vs last month"). */
	deltaLabel?: ReactNode
	icon?: ComponentType<{ className?: string }>
	/** For metrics where DOWN is good (churn, latency, cost) — flips the colour, not the arrow. */
	lowerIsBetter?: boolean
	className?: string
}

/** ONE KPI. A dashboard's top row is 3–4 of these, computed from real data — never hardcoded, and never
 *  without a comparison: a number with nothing to compare it to tells the reader nothing. */
export function StatCard({ label, value, delta, deltaLabel, icon: Icon, lowerIsBetter = false, className }: StatCardProps) {
	const good = delta === undefined ? undefined : lowerIsBetter ? delta < 0 : delta > 0
	const Arrow = delta !== undefined && delta < 0 ? ArrowDownRight : ArrowUpRight
	return (
		<div data-block="stat-card" className={cn('flex flex-col gap-3 rounded-xl border bg-card p-5', className)}>
			<div className="flex items-center justify-between gap-2">
				<span className="text-sm text-muted-foreground">{label}</span>
				{Icon ? <Icon className="size-4 text-muted-foreground" /> : null}
			</div>
			<span className="font-serif text-3xl font-semibold tabular-nums tracking-display">{value}</span>
			{delta !== undefined ? (
				<div className="flex items-center gap-1.5 text-sm">
					<span className={cn('flex items-center gap-0.5 font-medium tabular-nums', good ? 'text-primary' : 'text-destructive')}>
						<Arrow className="size-3.5" />
						{Math.abs(delta)}%
					</span>
					{deltaLabel ? <span className="text-muted-foreground">{deltaLabel}</span> : null}
				</div>
			) : null}
		</div>
	)
}
