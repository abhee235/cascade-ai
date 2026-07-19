import type { ComponentType, ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface Feature {
	/** A lucide icon component, e.g. `Truck` from 'lucide-react'. */
	icon: ComponentType<{ className?: string }>
	title: string
	description: ReactNode
}

export interface FeatureGridProps {
	features: Feature[]
	/** 3 for landing "why us" rows; 2 for denser app pages. */
	columns?: 2 | 3
	className?: string
}

/** Icon + title + description cards from a data array — the "why us" / capabilities band. */
export function FeatureGrid({ features, columns = 3, className }: FeatureGridProps) {
	return (
		<div data-block="feature-grid" className={cn('grid gap-6 sm:grid-cols-2', columns === 3 && 'lg:grid-cols-3', className)}>
			{features.map((f) => (
				<div key={f.title} className="flex flex-col gap-3 rounded-xl border bg-card p-6 shadow-xs">
					<span className="flex size-10 items-center justify-center rounded-lg bg-accent text-accent-foreground">
						<f.icon className="size-5" />
					</span>
					<h3 className="font-semibold">{f.title}</h3>
					<p className="text-sm text-muted-foreground">{f.description}</p>
				</div>
			))}
		</div>
	)
}
