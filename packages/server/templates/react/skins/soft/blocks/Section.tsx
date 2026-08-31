// SKIN: soft — same SectionProps, cushioned rhythm: the eyebrow becomes a tinted pill, and the toned
// bands (`muted`, `wash`) render as INSET rounded-3xl containers floating inside the page instead of
// full-bleed strips — soft never runs a band edge to edge, the same rule its Hero and NavBar follow.
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

/** Page rhythm wrapper — soft skin: toned bands float as rounded insets rather than cutting the page. */
export function Section({ eyebrow, heading, description, tone = 'default', children, className }: SectionProps) {
	const header =
		eyebrow || heading || description ? (
			<div className="mb-10 flex max-w-2xl flex-col gap-3">
				{eyebrow ? <span className="self-start rounded-full bg-primary/10 px-3 py-1 text-xs font-medium uppercase tracking-widest text-primary">{eyebrow}</span> : null}
				{heading ? <h2 className="font-serif text-3xl font-semibold tracking-display">{heading}</h2> : null}
				{description ? <p className="text-muted-foreground">{description}</p> : null}
			</div>
		) : null

	if (tone === 'default') {
		return (
			<section data-block="section" className={className}>
				<div className="mx-auto max-w-6xl px-6 py-section-y md:py-section-y-lg">
					{header}
					{children}
				</div>
			</section>
		)
	}
	return (
		<section data-block="section" className={cn('mx-auto max-w-6xl px-6 py-6', className)}>
			<div
				className={cn('relative isolate overflow-hidden rounded-3xl px-6 py-section-y sm:px-10', tone === 'muted' && 'bg-muted')}
				style={
					tone === 'wash'
						? {
								background:
									'radial-gradient(60% 50% at 15% 0%, color-mix(in oklab, var(--primary) 14%, transparent), transparent 70%), radial-gradient(55% 45% at 90% 8%, color-mix(in oklab, var(--accent) 60%, transparent), transparent 72%), var(--card)',
							}
						: undefined
				}
			>
				{header}
				{children}
			</div>
		</section>
	)
}
