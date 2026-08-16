// SKIN: soft — same FooterProps: the footer is a floating rounded card, inset from the viewport with a
// soft shadow — the page closes on a cushion, not a rule. Borderless, like every soft surface.
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface FooterColumn {
	heading: string
	links: ReactNode[]
}

export interface FooterProps {
	/** Brand name/mark, repeated small. */
	brand: ReactNode
	/** One-line tagline under the brand. */
	tagline?: string
	columns?: FooterColumn[]
	/** Small print (©, credits). */
	fineprint?: ReactNode
	className?: string
}

/** Page footer — soft skin: a floating card that closes the page. Every landing page ends with one. */
export function Footer({ brand, tagline, columns = [], fineprint, className }: FooterProps) {
	return (
		<footer data-block="footer" className={cn('px-6 pb-8 pt-4', className)}>
			<div className="mx-auto max-w-6xl rounded-3xl bg-card shadow-md shadow-foreground/5">
				<div className="flex flex-col gap-10 px-8 py-12 md:flex-row md:justify-between">
					<div className="flex flex-col gap-2">
						<div className="flex items-center gap-2.5 font-serif text-lg font-semibold tracking-display">{brand}</div>
						{tagline ? <p className="max-w-xs text-sm text-muted-foreground">{tagline}</p> : null}
					</div>
					<div className="flex flex-wrap gap-10 sm:gap-14">
						{columns.map((col) => (
							<div key={col.heading} className="flex min-w-32 flex-col gap-2.5">
								<h4 className="text-xs font-medium uppercase tracking-widest text-muted-foreground">{col.heading}</h4>
								{col.links.map((link, i) => (
									<span key={i} className="text-sm text-muted-foreground transition-colors hover:text-foreground">
										{link}
									</span>
								))}
							</div>
						))}
					</div>
				</div>
				{fineprint ? <div className="border-t border-border/60 px-8 py-5 text-xs text-muted-foreground">{fineprint}</div> : null}
			</div>
		</footer>
	)
}
