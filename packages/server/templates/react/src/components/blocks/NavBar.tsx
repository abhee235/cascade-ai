import type { ReactNode } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const navBarVariants = cva('top-0 z-40 w-full', {
	variants: {
		variant: {
			solid: 'sticky border-b bg-background',
			// Glass: translucent, blurred, floating over content — pair with a Hero right underneath.
			floating: 'fixed border-b border-border/50 bg-background/80 backdrop-blur-md',
		},
	},
	defaultVariants: { variant: 'solid' },
})

export interface NavBarProps extends VariantProps<typeof navBarVariants> {
	/** Brand: a <Logo> — the mark in a form chosen for the subject (never a bare stock icon beside the name). */
	brand: ReactNode
	/** Center links (render <a>/<button className="text-sm text-muted-foreground hover:text-foreground">). */
	links?: ReactNode
	/** Right side: actions (cart button, theme toggle, CTA…). */
	actions?: ReactNode
	className?: string
}

/** Site/app header. One per page, always at the top. Brand left, links center, actions right. */
export function NavBar({ brand, links, actions, variant, className }: NavBarProps) {
	return (
		<header data-block="navbar" className={cn(navBarVariants({ variant }), className)}>
			<nav className="mx-auto flex h-nav max-w-6xl items-center justify-between gap-6 px-6">
				<div className="flex items-center gap-2.5 font-serif text-lg font-semibold tracking-display">{brand}</div>
				{links ? <div className="hidden items-center gap-6 md:flex">{links}</div> : null}
				<div className="flex items-center gap-2">{actions}</div>
			</nav>
		</header>
	)
}
