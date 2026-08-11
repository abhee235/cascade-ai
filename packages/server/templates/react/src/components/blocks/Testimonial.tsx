import type { ReactNode } from 'react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { cn } from '@/lib/utils'

export interface TestimonialQuote {
	quote: ReactNode
	author: string
	role?: string
	/** Optional headshot URL; without one the block sets the author's initials in the avatar. */
	avatarSrc?: string
}

export interface TestimonialProps {
	quotes: TestimonialQuote[]
	/** cards: a grid (2–3 quotes) · feature: one large centered quote (use for a single strong voice). */
	variant?: 'cards' | 'feature'
	className?: string
}

const initials = (name: string) =>
	name
		.split(' ')
		.map((w) => w[0])
		.slice(0, 2)
		.join('')
		.toUpperCase()

/** SOCIAL PROOF in words. Real names and real roles or it reads as filler — never "John D., CEO". */
export function Testimonial({ quotes, variant = 'cards', className }: TestimonialProps) {
	if (variant === 'feature') {
		const q = quotes[0]
		if (!q) return null
		return (
			<figure data-block="testimonial" className={cn('mx-auto flex max-w-3xl flex-col items-center gap-6 text-center', className)}>
				<blockquote className="font-serif text-2xl leading-relaxed tracking-display md:text-3xl">“{q.quote}”</blockquote>
				<figcaption className="flex items-center gap-3">
					<Avatar>
						{q.avatarSrc ? <AvatarImage src={q.avatarSrc} alt={q.author} /> : null}
						<AvatarFallback>{initials(q.author)}</AvatarFallback>
					</Avatar>
					<div className="text-left text-sm">
						<div className="font-medium">{q.author}</div>
						{q.role ? <div className="text-muted-foreground">{q.role}</div> : null}
					</div>
				</figcaption>
			</figure>
		)
	}
	return (
		<div data-block="testimonial" className={cn('grid gap-6 md:grid-cols-2 lg:grid-cols-3', className)}>
			{quotes.map((q) => (
				<figure key={q.author} className="flex flex-col gap-5 rounded-xl border bg-card p-6">
					<blockquote className="text-sm leading-relaxed">“{q.quote}”</blockquote>
					<figcaption className="mt-auto flex items-center gap-3">
						<Avatar className="size-9">
							{q.avatarSrc ? <AvatarImage src={q.avatarSrc} alt={q.author} /> : null}
							<AvatarFallback>{initials(q.author)}</AvatarFallback>
						</Avatar>
						<div className="text-sm">
							<div className="font-medium">{q.author}</div>
							{q.role ? <div className="text-muted-foreground">{q.role}</div> : null}
						</div>
					</figcaption>
				</figure>
			))}
		</div>
	)
}
