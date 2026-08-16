// SKIN: sharp — same SectionProps, hard-ruled rhythm: the header hangs off a 4px left rule instead of
// floating in whitespace, `muted` becomes a band cut by 2px rules top and bottom, and `wash` — the base's
// soft radial atmosphere — becomes a flat DIAGONAL HATCH field (token-mixed, still preset-reactive).
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface SectionProps {
	/** Tiny uppercase label above the heading (e.g. "How it works"). */
	eyebrow?: string
	heading?: ReactNode
	description?: ReactNode
	/** muted: a full-width tinted band that breaks up long pages · wash: a soft gradient field derived
	 *  from the preset's primary/accent — atmosphere for a hero-adjacent or closing band. */
	tone?: 'default' | 'muted' | 'wash'
	children: ReactNode
	className?: string
}

/** Page rhythm wrapper — sharp skin: rules do the separating that whitespace does in base. */
export function Section({ eyebrow, heading, description, tone = 'default', children, className }: SectionProps) {
	return (
		<section data-block="section" className={cn(tone === 'muted' && 'border-y-2 bg-muted', tone === 'wash' && 'relative isolate overflow-hidden border-y-2', className)}>
			{tone === 'wash' ? (
				<div
					aria-hidden
					className="pointer-events-none absolute inset-0 -z-10"
					style={{
						background:
							'repeating-linear-gradient(-45deg, color-mix(in oklab, var(--primary) 7%, transparent) 0 2px, transparent 2px 14px)',
					}}
				/>
			) : null}
			<div className="mx-auto max-w-6xl px-6 py-section-y md:py-section-y-lg">
				{eyebrow || heading || description ? (
					<div className="mb-10 flex max-w-2xl flex-col gap-2.5 border-l-4 border-primary pl-4">
						{eyebrow ? <span className="text-xs font-medium uppercase tracking-[0.14em] text-primary">{eyebrow}</span> : null}
						{heading ? <h2 className="font-serif text-3xl font-semibold tracking-display">{heading}</h2> : null}
						{description ? <p className="text-muted-foreground">{description}</p> : null}
					</div>
				) : null}
				{children}
			</div>
		</section>
	)
}
