import { cn } from '@/lib/utils'

export interface LogoProps {
	/** The app's name — or its short form ("Cascade" for "Cascade Shop") — set as the brand. */
	name: string
	className?: string
}

/** THE BRAND — a wordmark: the app's name in the bold display face with ONE detail in the primary color (the
 *  last word of a two-word name, or a dot after a one-word name). No icon mark: a logo is personal to the
 *  owner, and they bring their own; a well-set name is the brand until then. It replaced a bare 16 px stock
 *  icon beside plain text (Store in 8 of 9 shops, Rocket in 4 of 9 landings — ADR-086). */
export function Logo({ name, className }: LogoProps) {
	const words = name.trim().split(/\s+/)
	return (
		<span data-block="logo" className={cn('inline-flex items-baseline font-serif text-xl font-bold tracking-display', className)}>
			{words.length > 1 ? (
				<>
					{words.slice(0, -1).join(' ')}&nbsp;<span className="text-primary">{words[words.length - 1]}</span>
				</>
			) : (
				<>
					{name}
					<span className="text-primary">.</span>
				</>
			)}
		</span>
	)
}
