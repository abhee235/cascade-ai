import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface CTASectionProps {
	headline: ReactNode
	subcopy?: ReactNode
	/** ONE primary <Button> (plus at most one outline) — this is the page's closing ask. */
	actions?: ReactNode
	/** A reassurance line under the buttons ("No card required · Cancel anytime"). */
	fineprint?: ReactNode
	/** panel: a contained card band · full: the primary color edge-to-edge (the loudest option, use once). */
	variant?: 'panel' | 'full'
	/** An in-page anchor (#start) goes ON the band — a wrapper div around a band breaks the rhythm. */
	id?: string
	className?: string
}

/** THE CLOSING ASK — the last band before the footer. A landing page without one ends in silence, and a
 *  visitor who scrolled to the bottom is the most likely to convert. */
export function CTASection({ headline, subcopy, actions, fineprint, variant = 'panel', id, className }: CTASectionProps) {
	const full = variant === 'full'
	return (
		<section id={id} data-block="cta-section" data-band={full ? 'primary' : 'plain'} className={cn('py-section-y md:py-section-y-lg', full && 'bg-primary text-primary-foreground', className)}>
			<div className="mx-auto max-w-6xl px-6">
				<div
					className={cn(
						'flex flex-col items-center gap-5 text-center',
						!full && 'rounded-xl border bg-card px-6 py-12 shadow-sm',
					)}
				>
					<h2 className={cn('max-w-2xl font-serif text-3xl font-semibold tracking-display leading-display md:text-4xl')}>{headline}</h2>
					{/* On the primary band every line is primary-foreground at FULL strength — size, not opacity, ranks
					    them (/85 and /70 fell below AA on saturated presets). */}
					{subcopy ? <p className={cn('max-w-xl', full ? 'text-primary-foreground' : 'text-muted-foreground')}>{subcopy}</p> : null}
					{/* On the primary band a kit outline/link button would paint the PAGE background (outline) or the
					    primary itself (link) under primary-foreground text — measured, ADR-086 P1: every landing that
					    paired a full CTA with an outline action rendered it white on white (1.01:1). The band restyles them. */}
					{actions ? (
						<div
							className={cn(
								'mt-1 flex flex-wrap items-center justify-center gap-3',
								full &&
									'[&_[data-variant=link]]:text-primary-foreground! [&_[data-variant=outline]]:border-primary-foreground/50! [&_[data-variant=outline]]:bg-transparent! [&_[data-variant=outline]]:text-primary-foreground! [&_[data-variant=outline]]:shadow-none! [&_[data-variant=outline]:hover]:bg-primary-foreground/10!',
							)}
						>
							{actions}
						</div>
					) : null}
					{fineprint ? <p className={cn('text-xs', full ? 'text-primary-foreground' : 'text-muted-foreground')}>{fineprint}</p> : null}
				</div>
			</div>
		</section>
	)
}
