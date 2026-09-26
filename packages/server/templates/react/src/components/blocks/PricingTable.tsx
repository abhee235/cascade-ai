import type { ReactNode } from 'react'
import { Check } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

export interface PricingTier {
	name: string
	/** Formatted, e.g. "$29" — the block adds the period. */
	price: string
	period?: string
	description?: ReactNode
	features: string[]
	/** The CTA for this tier — pass ONE <Button>; the highlighted tier's should be the primary. */
	action?: ReactNode
	/** Exactly ONE tier should set this: it gets the primary border, the badge, and the lift. */
	highlighted?: boolean
	badge?: string
}

export interface PricingTableProps {
	tiers: PricingTier[]
	className?: string
}

/** PRICING — 2 to 4 tiers, ONE highlighted. The highlight is the whole point: an undifferentiated row of
 *  identical cards makes the visitor choose, and a visitor who has to choose leaves. */
export function PricingTable({ tiers, className }: PricingTableProps) {
	return (
		<div data-block="pricing-table" className={cn('grid gap-6 md:grid-cols-2 lg:grid-cols-3', tiers.length === 2 && 'lg:grid-cols-2', tiers.length >= 4 && 'lg:grid-cols-4', className)}>
			{tiers.map((tier) => (
				<div
					key={tier.name}
					className={cn(
						'relative flex flex-col gap-5 rounded-xl border bg-card p-6',
						tier.highlighted && 'border-primary shadow-lg lg:-translate-y-2',
					)}
				>
					{tier.highlighted ? (
						<Badge className="absolute -top-3 left-6">{tier.badge ?? 'Most popular'}</Badge>
					) : null}
					<div className="flex flex-col gap-1">
						<h3 className="font-medium">{tier.name}</h3>
						{tier.description ? <p className="text-sm text-muted-foreground">{tier.description}</p> : null}
					</div>
					<div className="flex items-baseline gap-1">
						<span className="font-serif text-4xl font-semibold tracking-display">{tier.price}</span>
						{tier.period ? <span className="text-sm text-muted-foreground">/{tier.period}</span> : null}
					</div>
					<ul className="flex flex-col gap-2.5 text-sm">
						{tier.features.map((f) => (
							<li key={f} className="flex items-start gap-2">
								<Check className="mt-0.5 size-4 shrink-0 text-primary" />
								<span className="text-muted-foreground">{f}</span>
							</li>
						))}
					</ul>
					{tier.action ? <div className="mt-auto pt-2 [&>*]:w-full">{tier.action}</div> : null}
				</div>
			))}
		</div>
	)
}
