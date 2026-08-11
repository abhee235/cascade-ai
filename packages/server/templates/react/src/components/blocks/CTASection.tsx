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
	className?: string
}

/** THE CLOSING ASK — the last band before the footer. A landing page without one ends in silence, and a
 *  visitor who scrolled to the bottom is the most likely to convert. */
export function CTASection({ headline, subcopy, actions, fineprint, variant = 'panel', className }: CTASectionProps) {
	const full = variant === 'full'
	return (
		<section data-block="cta-section" className={cn(full && 'bg-primary text-primary-foreground', className)}>
			<div className={cn('mx-auto max-w-6xl px-6', full ? 'py-section-y' : 'py-section-y')}>
				<div
					className={cn(
						'flex flex-col items-center gap-5 text-center',
						!full && 'rounded-xl border bg-card px-6 py-12 shadow-sm',
					)}
				>
					<h2 className={cn('max-w-2xl font-serif text-3xl font-semibold tracking-display md:text-4xl')}>{headline}</h2>
					{subcopy ? <p className={cn('max-w-xl', full ? 'text-primary-foreground/85' : 'text-muted-foreground')}>{subcopy}</p> : null}
					{actions ? <div className="mt-1 flex flex-wrap items-center justify-center gap-3">{actions}</div> : null}
					{fineprint ? <p className={cn('text-xs', full ? 'text-primary-foreground/70' : 'text-muted-foreground')}>{fineprint}</p> : null}
				</div>
			</div>
		</section>
	)
}
