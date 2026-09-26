// SKIN: soft — same NavBarProps (variant names included). Structure: the bar becomes a floating PILL,
// inset from the viewport edges and always detached from content — soft's `solid` hovers too; `floating`
// adds the translucent blur. Borderless; a soft shadow separates it from the page.
import type { ReactNode } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const navBarVariants = cva('sticky top-3 z-40 mx-auto w-[calc(100%-1.5rem)] max-w-6xl rounded-full shadow-md shadow-foreground/5', {
	variants: {
		variant: {
			solid: 'bg-card',
			floating: 'bg-card/80 backdrop-blur-md',
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

/** Site/app header — soft skin: a detached pill floating over the page. Brand left, links center. */
export function NavBar({ brand, links, actions, variant, className }: NavBarProps) {
	return (
		<header data-block="navbar" className={cn(navBarVariants({ variant }), className)}>
			<nav className="flex h-nav items-center justify-between gap-6 px-6">
				<div className="flex items-center gap-2.5 font-serif text-lg font-semibold tracking-display">{brand}</div>
				{links ? <div className="hidden items-center gap-6 md:flex">{links}</div> : null}
				<div className="flex items-center gap-2">{actions}</div>
			</nav>
		</header>
	)
}
