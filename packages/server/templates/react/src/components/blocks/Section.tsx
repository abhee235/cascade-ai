import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface SectionProps {
	/** Tiny uppercase label above the heading (e.g. "How it works"). */
	eyebrow?: string
	heading?: ReactNode
	description?: ReactNode
	/** muted: a full-width tinted band that breaks up long pages. */
	tone?: 'default' | 'muted'
	children: ReactNode
	className?: string
}

/** Page rhythm wrapper — every content band between Hero and Footer should be a Section.
 *  Encodes the vertical rhythm (py-16/24) and container (max-w-6xl px-6) so pages breathe evenly. */
export function Section({ eyebrow, heading, description, tone = 'default', children, className }: SectionProps) {
	return (
		<section data-block="section" className={cn(tone === 'muted' && 'bg-muted', className)}>
			<div className="mx-auto max-w-6xl px-6 py-16 md:py-20">
				{eyebrow || heading || description ? (
					<div className="mb-10 flex max-w-2xl flex-col gap-3">
						{eyebrow ? <span className="text-xs font-medium uppercase tracking-widest text-primary">{eyebrow}</span> : null}
						{heading ? <h2 className="font-serif text-3xl font-semibold tracking-tight">{heading}</h2> : null}
						{description ? <p className="text-muted-foreground">{description}</p> : null}
					</div>
				) : null}
				{children}
			</div>
		</section>
	)
}
