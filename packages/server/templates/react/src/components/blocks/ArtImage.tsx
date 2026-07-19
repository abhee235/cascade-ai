import { useId } from 'react'
import { cn } from '@/lib/utils'

/* Deterministic, token-aware SVG art. Same seed ⇒ same art, forever. Fills use ONLY theme tokens
   (var(--primary), var(--chart-*), var(--muted)) so every piece re-colors itself under any preset and
   in dark mode. Use for products/covers/avatars when no real photo fits — NEVER an emoji, never a
   gray box. */

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
	const rot = pick(5, 360)
	const variant = kind === 'avatar' ? 6 : kind === 'banner' ? 5 : pick(8, 5)
	const initials = seed
		.split(/\s+/)
		.slice(0, 2)
		.map((w) => w[0]?.toUpperCase() ?? '')
		.join('')

	return (
		<svg data-art viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice" role="img" aria-label={seed} className={cn('block size-full', className)}>
			<defs>
				<linearGradient id={gid} gradientTransform={`rotate(${rot % 90})`}>
					<stop offset="0%" stopColor={a} stopOpacity="0.25" />
					<stop offset="100%" stopColor={b} stopOpacity="0.12" />
				</linearGradient>
			</defs>
			<rect width="400" height="300" fill="var(--muted)" />
			<rect width="400" height="300" fill={`url(#${gid})`} />
			{variant === 0 && ( // duotone blob pair
				<g>
					<circle cx={120 + pick(2, 80)} cy={110 + pick(4, 60)} r={70 + pick(6, 40)} fill={a} opacity="0.5" />
					<circle cx={250 + pick(7, 60)} cy={170 + pick(9, 50)} r={50 + pick(11, 35)} fill={b} opacity="0.4" />
				</g>
			)}
			{variant === 1 && ( // concentric rings
				<g fill="none" stroke={a} opacity="0.5">
					{[28, 56, 84, 112].map((r, i) => (
						<circle key={r} cx={200 + (pick(2, 60) - 30)} cy={150 + (pick(4, 40) - 20)} r={r} strokeWidth={10 - i * 2} stroke={i % 2 ? b : a} />
					))}
				</g>
			)}
			{variant === 2 && ( // dot grid
				<g fill={a} opacity="0.45">
					{Array.from({ length: 24 }, (_, i) => (
						<circle key={i} cx={40 + (i % 6) * 64 + pick(i % 13, 12)} cy={40 + Math.floor(i / 6) * 60} r={6 + ((h >>> (i % 20)) % 8)} fill={i % 5 === 0 ? b : a} />
					))}
				</g>
			)}
			{variant === 3 && ( // diagonal beams
				<g transform={`rotate(${-18 + pick(3, 36)} 200 150)`}>
					{[0, 1, 2, 3].map((i) => (
						<rect key={i} x={-60 + i * 130 + pick(i + 2, 40)} y="-60" width={36 + pick(i + 5, 30)} height="420" rx="18" fill={i % 2 ? b : a} opacity={0.4 - i * 0.05} />
					))}
				</g>
			)}
			{variant === 4 && ( // rounded bars (skyline)
				<g fill={a} opacity="0.5">
					{[0, 1, 2, 3, 4].map((i) => (
						<rect key={i} x={40 + i * 68} y={90 + ((h >>> (i * 3)) % 110)} width="44" rx="10" height="240" fill={i % 2 ? b : a} />
					))}
				</g>
			)}
			{variant === 5 && ( // banner: layered horizon waves
				<g fill="none">
					<path d={`M0 ${180 + pick(2, 40)} Q 100 ${120 + pick(4, 60)} 200 ${170 + pick(6, 30)} T 400 ${150 + pick(8, 50)} V300 H0 Z`} fill={a} opacity="0.35" />
					<path d={`M0 ${220 + pick(3, 30)} Q 130 ${170 + pick(5, 40)} 240 ${215 + pick(7, 25)} T 400 ${200 + pick(9, 40)} V300 H0 Z`} fill={b} opacity="0.45" />
				</g>
			)}
			{variant === 6 && ( // avatar: initials on duotone field
				<g>
					<circle cx="200" cy="150" r="86" fill={a} opacity="0.35" />
					<text x="200" y="150" textAnchor="middle" dominantBaseline="central" fontFamily="var(--font-serif)" fontSize="88" fontWeight="600" fill="var(--foreground)" opacity="0.75">
						{initials || '·'}
					</text>
				</g>
			)}
		</svg>
	)
}
