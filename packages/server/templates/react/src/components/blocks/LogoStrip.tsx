import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface LogoStripProps {
	/** The quiet trust line above the row, e.g. "Trusted by teams everywhere". */
	label?: ReactNode
	/** Wordmarks (plain strings read as set type) or small nodes — 4 to 8 of them. */
	items: ReactNode[]
	/** bordered: hairline cells (the shadcn-blocks look) · bare: floating, no cell borders. */
	variant?: 'bordered' | 'bare'
	className?: string
}

/** LOGO STRIP — the social-proof band that sits directly under a hero: a trust line plus a row of
 *  wordmarks. Real logos are rarely available while prototyping, so plain text wordmarks are the
 *  intended default — set in the sans face, muted, they read as a credible trust row. */
export function LogoStrip({ label, items, variant = 'bordered', className }: LogoStripProps) {
	return (
		<div data-block="logo-strip" className={cn('flex flex-col items-center gap-6', className)}>
			{label ? <p className="text-sm text-muted-foreground">{label}</p> : null}
			{/* Cell borders COLLAPSE via -m-px rather than showing through a gap: a tinted parent with
			    gap-px paints a solid slab wherever the last row is short, and the item count can't line up
			    with three different breakpoint column counts. This way any count renders cleanly. */}
			<div className={cn('grid w-full grid-cols-2 sm:grid-cols-3 lg:grid-cols-6', variant === 'bare' && 'gap-6')}>
				{items.map((item, i) => (
					<div
						key={i}
						className={cn(
							'flex items-center justify-center px-4 py-5 text-base font-medium text-muted-foreground transition-colors',
							variant === 'bordered' && '-m-px border bg-card hover:text-foreground',
						)}
					>
						{item}
					</div>
				))}
			</div>
		</div>
	)
}
