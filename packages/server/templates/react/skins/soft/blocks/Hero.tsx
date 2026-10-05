// SKIN: soft — same HeroProps, all four layouts, pillowed: media floats in a rounded-3xl shadowed frame,
// `collage` becomes a stack of soft tinted CUSHIONS behind the image (rounded, blurred-edge warmth, where
// sharp uses hard offset rules), and `bleed` rounds the whole band into an inset panel instead of running
// edge-to-edge — soft never touches the viewport edge.
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
	/** split: text left, media right · centered: text centered, no media emphasis · bleed: media as full
	 *  background · collage: media layered over offset tinted panels (the modern, depth-y landing look). */
	layout?: 'split' | 'centered' | 'bleed' | 'collage'
	className?: string
}

/** The first thing on a landing/marketing page — soft skin: floating frames, cushioned depth. */
export function Hero({ badge, headline, subcopy, actions, media, layout = 'split', className }: HeroProps) {
	const text = (
		<div className={cn('flex max-w-xl flex-col gap-5', layout === 'centered' && 'items-center text-center', layout === 'bleed' && 'items-start')}>
			{badge ? <div>{badge}</div> : null}
			<h1
				className={cn(
					'font-serif font-semibold tracking-display leading-display',
					layout === 'centered' ? 'text-5xl md:text-6xl' : 'text-4xl md:text-5xl lg:text-6xl',
					layout === 'bleed' && 'text-background',
				)}
			>
				{headline}
			</h1>
			{subcopy ? <p className={cn('text-lg', layout === 'bleed' ? 'text-background/80' : 'text-muted-foreground')}>{subcopy}</p> : null}
			{actions ? <div className="mt-1 flex flex-wrap items-center gap-3">{actions}</div> : null}
		</div>
	)

	if (layout === 'bleed') {
		return (
			<section data-block="hero" data-band="plain" className={cn('mx-auto max-w-6xl px-6 py-6', className)}>
				<div className="relative overflow-hidden rounded-3xl shadow-lg shadow-foreground/10">
					<div className="absolute inset-0 [&>img]:size-full [&>img]:object-cover">{media}</div>
					<div className="absolute inset-0 bg-gradient-to-r from-foreground/80 via-foreground/40 to-transparent" />
					<div className="relative flex min-h-[420px] items-center px-8 py-hero-y">{text}</div>
				</div>
			</section>
		)
	}
	if (layout === 'collage') {
		return (
			<section data-block="hero" data-band="plain" className={cn('mx-auto max-w-6xl px-6 py-section-y md:py-hero-y', className)}>
				<div className="grid grid-cols-1 items-center gap-12 md:grid-cols-2">
					{text}
					{media ? (
						<div className="relative isolate">
							<div aria-hidden className="absolute -right-4 -top-6 -z-10 h-full w-3/4 rounded-[2.5rem] bg-primary/10" />
							<div aria-hidden className="absolute -bottom-6 -left-5 -z-10 h-2/3 w-2/3 rounded-[2.5rem] bg-accent" />
							<div className="overflow-hidden rounded-3xl shadow-lg shadow-foreground/10 [&>img]:aspect-[4/3] [&>img]:size-full [&>img]:object-cover">{media}</div>
						</div>
					) : null}
				</div>
			</section>
		)
	}
	return (
		<section data-block="hero" data-band="plain" className={cn('mx-auto max-w-6xl px-6 py-section-y md:py-hero-y', className)}>
			{layout === 'centered' ? (
				<div className="flex flex-col items-center">{text}</div>
			) : (
				<div className="grid grid-cols-1 items-center gap-10 md:grid-cols-2">
					{text}
					{media ? <div className="overflow-hidden rounded-3xl shadow-lg shadow-foreground/10 [&>img]:aspect-[4/3] [&>img]:size-full [&>img]:object-cover">{media}</div> : null}
				</div>
			)}
		</section>
	)
}
