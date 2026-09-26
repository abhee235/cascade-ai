import { useState } from 'react'
import { ArtImage, type ArtImageProps } from './ArtImage'
import { seedPhoto, webPhoto } from '@/lib/photos'
import { cn } from '@/lib/utils'

/* A real photo WITH a guaranteed fallback. `web` is EITHER space-separated keywords describing the subject
   (e.g. "leather watch minimal") OR a direct https:// image URL returned by the ImageSearch tool. Keywords
   pull a real, subject-relevant photo from our allowlisted hotlink-safe source. If the image is blocked,
   slow, or fails it RETRIES ONCE and only then swaps to deterministic <ArtImage> — so the result is NEVER
   a broken box, and one flaky response never permanently downgrades a card to abstract art. Omit `web` and
   it's just <ArtImage>. Use for e-commerce products, listings, and any surface where generated art looks
   too abstract for a real subject. */
export interface PhotoProps {
	/** Keywords for the real photo (e.g. product.name + a category hint), OR a direct https:// URL from
	 *  the ImageSearch tool when the photo MUST match its label. Omit → ArtImage only. */
	web?: string
	/** Deterministic seed (usually the item name/id): same seed ⇒ same photo AND same fallback art. */
	seed: string
	/** ArtImage style when there's no web photo or it fails. */
	kind?: ArtImageProps['kind']
	className?: string
	alt?: string
}

/** An ImageSearch result is a ready URL, not keywords — passing it through webPhoto() would bake it into a
 *  keyword path and guarantee a miss. Detect and use it verbatim. */
const isDirectUrl = (s: string) => /^https?:\/\//i.test(s)

export function Photo({ web, seed, kind = 'product', className, alt }: PhotoProps) {
	const [attempt, setAttempt] = useState(0)
	const direct = !!web && isDirectUrl(web)
	// The second attempt switches SOURCE rather than re-rolling the same one. Measured 2026-09-27: the
	// keyword host answers 401 to every request, so a same-host retry only buys a second failure — while
	// picsum (the other allowlisted source) is up. A real photograph of something else still beats abstract
	// art for a hero or a lifestyle shot, which is all the keyword path ever promised.
	// A DIRECT url is different: it names a specific subject, so a random stand-in under that label would be
	// a lie. It gets one shot, then deterministic art.
	const lastAttempt = direct ? 0 : 1
	if (!web || attempt > lastAttempt) return <ArtImage seed={seed} kind={kind} className={className} />
	const src = direct ? web : attempt === 0 ? webPhoto(web, seed) : seedPhoto(seed, 600, 600)
	return (
		<img
			// Remount per attempt so the browser refetches instead of reusing the failed response.
			key={attempt}
			src={src}
			alt={alt ?? seed}
			loading="lazy"
			onError={() => setAttempt((n) => n + 1)}
			className={cn('h-full w-full object-cover', className)}
		/>
	)
}
