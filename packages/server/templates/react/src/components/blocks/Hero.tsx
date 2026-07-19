import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface HeroProps {
	/** Small pill above the headline (e.g. <Badge variant="secondary">New — Spring drop</Badge>). */
	badge?: ReactNode
	/** The display headline. Rendered in the serif display face — keep it under ~10 words. */
	headline: ReactNode
	/** One supporting sentence, muted. */
	subcopy?: ReactNode
	/** CTA row — put ONE <Button> (primary) and optionally one <Button variant="outline">. */
	actions?: ReactNode
	/** Media slot: a photo (`<img src={photo('…')}/>`), an <ArtImage>, or any visual. */
	media?: ReactNode
	/** split: text left, media right · centered: no media emphasis, text centered · bleed: media as full background. */
	layout?: 'split' | 'centered' | 'bleed'
	className?: string
}

/** The first thing on a landing/marketing page. Big serif headline, one CTA, optional media. */
export function Hero({ badge, headline, subcopy, actions, media, layout = 'split', className }: HeroProps) {
	const text = (
		<div className={cn('flex max-w-xl flex-col gap-5', layout === 'centered' && 'items-center text-center', layout === 'bleed' && 'items-start')}>
			{badge ? <div>{badge}</div> : null}
			<h1 className={cn('font-serif font-semibold tracking-tight', layout === 'centered' ? 'text-5xl' : 'text-4xl md:text-5xl', layout === 'bleed' && 'text-background')}>{headline}</h1>
			{subcopy ? <p className={cn('text-lg', layout === 'bleed' ? 'text-background/80' : 'text-muted-foreground')}>{subcopy}</p> : null}
			{actions ? <div className="mt-1 flex flex-wrap items-center gap-3">{actions}</div> : null}
		</div>
	)

	if (layout === 'bleed') {
		return (
			<section data-block="hero" className={cn('relative overflow-hidden', className)}>
				<div className="absolute inset-0">{media}</div>
				<div className="absolute inset-0 bg-gradient-to-r from-foreground/80 via-foreground/40 to-transparent" />
				<div className="relative mx-auto flex min-h-[420px] max-w-6xl items-center px-6 py-20">{text}</div>
			</section>
		)
	}
	return (
		<section data-block="hero" className={cn('mx-auto max-w-6xl px-6 py-16 md:py-24', className)}>
			{layout === 'centered' ? (
				<div className="flex flex-col items-center">{text}</div>
			) : (
				<div className="grid items-center gap-10 md:grid-cols-2">
					{text}
					{media ? <div className="overflow-hidden rounded-xl shadow-lg">{media}</div> : null}
				</div>
			)}
		</section>
	)
}
