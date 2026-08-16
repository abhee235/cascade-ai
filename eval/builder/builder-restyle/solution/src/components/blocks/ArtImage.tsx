// SKIN: sharp — same ArtImageProps, ANGULAR generative language: triangles, hard stripes, stepped bars,
// chevrons; the banner is a polyline ridge, the avatar sits in a square frame. Same hash, same token-only
// palette, same determinism — a seed renders the same art forever, it is just drawn with a harder pen.
// This is the "ArtImage palette per skin" leg of the P5 plan: a restyle changes the ART STYLE too.
import { useId } from 'react'
import { cn } from '@/lib/utils'

/** FNV-1a — tiny, deterministic string hash. */
function hash(s: string): number {
	let h = 0x811c9dc5
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i)
		h = Math.imul(h, 0x01000193)
	}
	return h >>> 0
}

const PALETTE = ['var(--primary)', 'var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)']

export interface ArtImageProps {
	/** Drives everything: same seed (e.g. the product name) always renders the same art. */
	seed: string
	/** product: object-ish art · banner: wide scenic gradients · avatar: initials · abstract: pure pattern. */
	kind?: 'product' | 'banner' | 'avatar' | 'abstract'
	className?: string
}

export function ArtImage({ seed, kind = 'product', className }: ArtImageProps) {
	const gid = useId()
	const h = hash(seed + kind)
	const pick = (n: number, m: number) => (h >>> n) % m
	const a = PALETTE[pick(0, 6)]
	const b = PALETTE[(pick(0, 6) + 1 + pick(3, 4)) % 6]
	const variant = kind === 'avatar' ? 6 : kind === 'banner' ? 5 : pick(8, 5)
	const initials = seed
		.split(/\s+/)
		.slice(0, 2)
		.map((w) => w[0]?.toUpperCase() ?? '')
		.join('')

	return (
		<svg data-art viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice" role="img" aria-label={seed} className={cn('block size-full', className)}>
			<defs>
				<linearGradient id={gid} gradientTransform={`rotate(${pick(5, 360) % 90})`}>
					<stop offset="0%" stopColor={a} stopOpacity="0.2" />
					<stop offset="100%" stopColor={b} stopOpacity="0.1" />
				</linearGradient>
			</defs>
			<rect width="400" height="300" fill="var(--muted)" />
			<rect width="400" height="300" fill={`url(#${gid})`} />
			{variant === 0 && ( // interlocking triangles
				<g opacity="0.5">
					<polygon points={`${40 + pick(2, 60)},260 ${170 + pick(4, 40)},${60 + pick(6, 50)} ${300 + pick(7, 40)},260`} fill={a} />
					<polygon points={`${150 + pick(9, 50)},260 ${260 + pick(11, 40)},${110 + pick(13, 60)} ${380},260`} fill={b} opacity="0.8" />
				</g>
			)}
			{variant === 1 && ( // hard vertical stripes, uneven widths
				<g opacity="0.5">
					{[0, 1, 2, 3, 4].map((i) => (
						<rect key={i} x={30 + i * 74 + pick(i + 2, 20)} y="0" width={12 + pick(i + 4, 34)} height="300" fill={i % 2 ? b : a} />
					))}
				</g>
			)}
			{variant === 2 && ( // stepped bars (bar-chart silhouette, flat tops)
				<g opacity="0.55">
					{[0, 1, 2, 3, 4, 5].map((i) => (
						<rect key={i} x={28 + i * 60} y={70 + ((h >>> (i * 4)) % 150)} width="46" height="300" fill={i % 3 === 1 ? b : a} />
					))}
				</g>
			)}
			{variant === 3 && ( // chevrons
				<g fill="none" strokeWidth="16" opacity="0.5">
					{[0, 1, 2].map((i) => (
						<polyline key={i} points={`20,${90 + i * 70 + pick(i + 3, 20)} 200,${30 + i * 70} 380,${90 + i * 70 + pick(i + 6, 20)}`} stroke={i % 2 ? b : a} />
					))}
				</g>
			)}
			{variant === 4 && ( // corner-cut frame + diagonal
				<g opacity="0.55">
					<polygon points="0,0 140,0 0,140" fill={a} />
					<polygon points="400,300 260,300 400,160" fill={b} />
					<rect x="185" y="-40" width="20" height="420" transform={`rotate(${30 + pick(4, 30)} 200 150)`} fill={a} />
				</g>
			)}
			{variant === 5 && ( // banner: polyline ridge line
				<g>
					<polyline
						points={`0,${210 + pick(2, 40)} 80,${120 + pick(4, 60)} 160,${190 + pick(6, 30)} 240,${90 + pick(8, 60)} 320,${170 + pick(10, 40)} 400,${130 + pick(12, 40)}`}
						fill="none"
						stroke={a}
						strokeWidth="10"
						opacity="0.55"
					/>
					<polygon points={`0,300 0,${230 + pick(3, 30)} 100,${180 + pick(5, 40)} 220,${240 + pick(7, 20)} 320,${200 + pick(9, 30)} 400,${230 + pick(11, 30)} 400,300`} fill={b} opacity="0.45" />
				</g>
			)}
			{variant === 6 && ( // avatar: initials in a square frame
				<g>
					<rect x="120" y="70" width="160" height="160" fill={a} opacity="0.3" />
					<rect x="120" y="70" width="160" height="160" fill="none" stroke={a} strokeWidth="6" opacity="0.6" />
					<text x="200" y="150" textAnchor="middle" dominantBaseline="central" fontFamily="var(--font-mono)" fontSize="76" fontWeight="600" fill="var(--foreground)" opacity="0.75">
						{initials || '·'}
					</text>
				</g>
			)}
		</svg>
	)
}
