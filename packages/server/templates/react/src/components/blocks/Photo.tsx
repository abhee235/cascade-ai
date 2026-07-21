import { useState } from 'react'
import { ArtImage, type ArtImageProps } from './ArtImage'
import { webPhoto } from '@/lib/photos'
import { cn } from '@/lib/utils'

/* A real photo WITH a guaranteed fallback. Pass `web` = space-separated keywords describing the subject
   (e.g. "leather watch minimal") to pull a real, subject-relevant photo from our allowlisted hotlink-safe
   source; if that image is blocked, slow, or fails, it swaps to deterministic <ArtImage> — so the result
   is NEVER a broken box. Omit `web` and it's just <ArtImage>. Use for e-commerce products, listings, and
   any surface where generated art looks too abstract for a real subject. */
export interface PhotoProps {
	/** Keywords for the real photo, e.g. product.name + a category hint. Omit → ArtImage only. */
	web?: string
	/** Deterministic seed (usually the item name/id): same seed ⇒ same photo AND same fallback art. */
	seed: string
	/** ArtImage style when there's no web photo or it fails. */
	kind?: ArtImageProps['kind']
	className?: string
	alt?: string
}

export function Photo({ web, seed, kind = 'product', className, alt }: PhotoProps) {
	const [failed, setFailed] = useState(false)
	if (!web || failed) return <ArtImage seed={seed} kind={kind} className={className} />
	return (
		<img
			src={webPhoto(web, seed)}
			alt={alt ?? seed}
			loading="lazy"
			onError={() => setFailed(true)}
			className={cn('h-full w-full object-cover', className)}
		/>
	)
}
