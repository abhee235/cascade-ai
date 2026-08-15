// SKIN: sharp — same NavBarProps (including the cva variant names, which are part of the interface),
// different structure: links move to the RIGHT beside the actions, the brand is uppercase tracked, and
// the bar is a solid 2px rule — no translucency or blur even for `floating` (sharp's take on floating is
// fixed-but-opaque: the glass look belongs to softer skins).
import type { ReactNode } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const navBarVariants = cva('top-0 z-40 w-full border-b-2 bg-background', {
	variants: {
		variant: {
			solid: 'sticky',
			// Base blurs this over content; sharp keeps it fixed but OPAQUE — flat surfaces, hard edges.
			floating: 'fixed',
		},
	},
	defaultVariants: { variant: 'solid' },
})

export interface NavBarProps extends VariantProps<typeof navBarVariants> {
	/** Brand: name + optional icon slot (a lucide icon or a small logo mark). */
	brand: ReactNode
	/** Center links (render <a>/<button className="text-sm text-muted-foreground hover:text-foreground">). */
	links?: ReactNode
	/** Right side: actions (cart button, theme toggle, CTA…). */
	actions?: ReactNode
	className?: string
}

/** Site/app header. One per page, always at the top. Sharp skin: brand left, links + actions right. */
export function NavBar({ brand, links, actions, variant, className }: NavBarProps) {
	return (
		<header data-block="navbar" className={cn(navBarVariants({ variant }), className)}>
			<nav className="mx-auto flex h-nav max-w-6xl items-center justify-between gap-6 px-6">
				<div className="flex items-center gap-2.5 text-sm font-semibold uppercase tracking-[0.14em]">{brand}</div>
				<div className="flex items-center gap-6">
					{links ? <div className="hidden items-center gap-6 md:flex">{links}</div> : null}
					<div className="flex items-center gap-2">{actions}</div>
				</div>
			</nav>
		</header>
	)
}
