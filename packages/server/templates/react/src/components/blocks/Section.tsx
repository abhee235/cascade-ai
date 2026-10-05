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

/** A BAND — every content stripe between Hero and Footer is one. It owns its vertical padding (the preset's
 *  density tokens) and its container (max-w-6xl px-6); the band that FOLLOWS decides the gap (src/index.css
 *  drops the padding two adjacent bands would stack), so never add py/my around it. */
export function Section({ eyebrow, heading, description, tone = 'default', compact = false, id, children, className }: SectionProps) {
	return (
		<section
			id={id}
			data-block="section"
			data-band={tone === 'default' ? 'plain' : tone}
			data-compact={compact ? '' : undefined}
			className={cn(
				compact ? 'py-section-compact md:py-section-compact-lg' : 'py-section-y md:py-section-y-lg',
				tone === 'muted' && 'bg-muted',
				tone === 'wash' && 'relative isolate overflow-hidden',
				className,
			)}
		>
			{tone === 'wash' ? (
				<div
					aria-hidden
					className="pointer-events-none absolute inset-0 -z-10"
					style={{
						background:
							'radial-gradient(55% 45% at 12% -5%, color-mix(in oklab, var(--primary) 16%, transparent), transparent 70%), radial-gradient(50% 42% at 92% 0%, color-mix(in oklab, var(--accent) 70%, transparent), transparent 72%)',
					}}
				/>
			) : null}
			<div className="mx-auto max-w-6xl px-6">
				{eyebrow || heading || description ? (
					<div className="mb-10 flex max-w-2xl flex-col gap-3">
						{eyebrow ? <span className="text-xs font-medium uppercase tracking-widest text-primary">{eyebrow}</span> : null}
						{heading ? <h2 className="font-serif text-3xl font-semibold tracking-display">{heading}</h2> : null}
						{description ? <p className="text-muted-foreground">{description}</p> : null}
					</div>
				) : null}
				{children}
			</div>
		</section>
	)
}
