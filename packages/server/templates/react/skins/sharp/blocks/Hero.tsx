// SKIN: sharp — same HeroProps, including all four layout values (they are part of the interface), each
// re-interpreted flat: no soft panels, no shadows, no rounded frames. `collage` — the base's layered
// depth look — becomes a double-rule OFFSET FRAME: the same "this image is presented" emphasis, achieved
// with hard lines instead of soft layers. A skin re-interprets; it never drops a prop or a variant.
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

/** The first thing on a landing/marketing page — sharp skin: hard rules, flat frames, tight tracking. */
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
			{/* The sharp signature: a hard rule under the headline instead of whitespace doing the separating. */}
			<div className={cn('h-0.5 w-16 bg-foreground', layout === 'centered' && 'mx-auto', layout === 'bleed' && 'bg-background')} aria-hidden />
			{subcopy ? <p className={cn('text-lg', layout === 'bleed' ? 'text-background/80' : 'text-muted-foreground')}>{subcopy}</p> : null}
			{actions ? <div className="mt-1 flex flex-wrap items-center gap-3">{actions}</div> : null}
		</div>
	)

	if (layout === 'bleed') {
		return (
			<section data-block="hero" data-band="media" className={cn('relative overflow-hidden', className)}>
				<div className="absolute inset-0 [&>img]:size-full [&>img]:object-cover">{media}</div>
				<div className="absolute inset-0 bg-gradient-to-r from-foreground/80 via-foreground/40 to-transparent" />
				<div className="relative mx-auto flex min-h-[420px] max-w-6xl items-center px-6 py-hero-y">{text}</div>
			</section>
		)
	}
	if (layout === 'collage') {
		return (
			<section data-block="hero" data-band="plain" className={cn('mx-auto max-w-6xl px-6 py-section-y md:py-hero-y', className)}>
				<div className="grid grid-cols-1 items-center gap-12 md:grid-cols-2">
					{text}
					{media ? (
						<div className="relative">
							{/* The offset frame: one hard outline displaced behind the image — collage, flattened. */}
							<div aria-hidden className="absolute -right-3 -top-3 h-full w-full border-2" />
							<div className="relative overflow-hidden border-2 bg-card [&>img]:aspect-[4/3] [&>img]:size-full [&>img]:object-cover">{media}</div>
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
					{media ? <div className="overflow-hidden border-2 [&>img]:aspect-[4/3] [&>img]:size-full [&>img]:object-cover">{media}</div> : null}
				</div>
			)}
		</section>
	)
}
