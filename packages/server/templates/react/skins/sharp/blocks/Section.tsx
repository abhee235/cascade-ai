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
	/** A THIN band — a logo row, a stat strip, one quote: a shorter step, so it sits close under the band it
	 *  supports (a thin band with a full step on both sides reads as empty). */
	compact?: boolean
	/** An in-page anchor (#pricing) goes ON the band — a wrapper div around a band breaks the rhythm. */
	id?: string
	children: ReactNode
	className?: string
}

/** Page rhythm wrapper — sharp skin: rules do the separating that whitespace does in base. A band: it owns
 *  its vertical padding, and the band that follows decides the gap (src/index.css). */
export function Section({ eyebrow, heading, description, tone = 'default', compact = false, id, children, className }: SectionProps) {
	return (
		<section
			id={id}
			data-block="section"
			data-band={tone === 'default' ? 'plain' : tone}
			data-compact={compact ? '' : undefined}
			className={cn(
				compact ? 'py-section-compact md:py-section-compact-lg' : 'py-section-y md:py-section-y-lg',
				tone === 'muted' && 'border-y-2 bg-muted',
				tone === 'wash' && 'relative isolate overflow-hidden border-y-2',
				className,
			)}
		>
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
			<div className="mx-auto max-w-6xl px-6">
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
