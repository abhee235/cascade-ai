import { cn } from '@/lib/utils'

export interface Stat {
	value: string
	label: string
}

export interface StatStripProps {
	stats: Stat[]
	className?: string
}

/** A row of 3–4 big numbers (social proof / key metrics). Value in serif display, label muted. */
export function StatStrip({ stats, className }: StatStripProps) {
	return (
		<div data-block="stat-strip" className={cn('grid grid-cols-2 gap-8 md:grid-cols-4', stats.length === 3 && 'md:grid-cols-3', className)}>
			{stats.map((s) => (
				<div key={s.label} className="flex flex-col gap-1 border-l-2 border-primary/30 pl-4">
					<span className="font-serif text-3xl font-semibold tracking-tight">{s.value}</span>
					<span className="text-sm text-muted-foreground">{s.label}</span>
				</div>
			))}
		</div>
	)
}
