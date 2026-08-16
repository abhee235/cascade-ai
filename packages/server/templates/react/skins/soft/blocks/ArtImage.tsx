// SKIN: soft — same ArtImageProps, ORGANIC generative language: overlapping translucent blobs, nested
// petals, scattered bubbles, smooth dunes; the banner is layered rolling waves, the avatar floats on
// concentric halos. Same hash, same token-only palette, same determinism — a softer brush, not new art.
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
				<radialGradient id={gid} cx={`${25 + pick(5, 50)}%`} cy={`${20 + pick(7, 40)}%`}>
					<stop offset="0%" stopColor={a} stopOpacity="0.28" />
					<stop offset="100%" stopColor={b} stopOpacity="0.08" />
				</radialGradient>
			</defs>
			<rect width="400" height="300" fill="var(--muted)" />
			<rect width="400" height="300" fill={`url(#${gid})`} />
			{variant === 0 && ( // overlapping cloud blobs
				<g opacity="0.45">
					<ellipse cx={130 + pick(2, 60)} cy={130 + pick(4, 50)} rx={95 + pick(6, 30)} ry={70 + pick(8, 25)} fill={a} />
					<ellipse cx={260 + pick(9, 60)} cy={175 + pick(11, 40)} rx={80 + pick(13, 30)} ry={60 + pick(15, 20)} fill={b} opacity="0.8" />
					<ellipse cx={200 + pick(17, 40)} cy={100 + pick(19, 40)} rx={55} ry={42} fill={b} opacity="0.5" />
				</g>
			)}
			{variant === 1 && ( // nested petals
				<g opacity="0.5">
					{[95, 70, 45, 24].map((r, i) => (
						<ellipse key={r} cx={200 + (pick(2, 50) - 25)} cy={150 + (pick(4, 30) - 15)} rx={r} ry={r * 0.72} fill={i % 2 ? b : a} opacity={0.35 + i * 0.12} transform={`rotate(${i * (12 + pick(6, 14))} 200 150)`} />
					))}
				</g>
			)}
			{variant === 2 && ( // scattered bubbles
				<g opacity="0.5">
					{Array.from({ length: 14 }, (_, i) => (
						<circle key={i} cx={35 + ((h >>> (i % 16)) % 340)} cy={35 + ((h >>> ((i + 5) % 16)) % 230)} r={8 + ((h >>> ((i + 9) % 20)) % 26)} fill={i % 3 === 1 ? b : a} opacity={0.25 + (i % 4) * 0.1} />
					))}
				</g>
			)}
			{variant === 3 && ( // smooth dunes
				<g opacity="0.5">
					<path d={`M0 ${170 + pick(2, 40)} C 90 ${110 + pick(4, 50)}, 190 ${210 + pick(6, 40)}, 400 ${140 + pick(8, 50)} V300 H0 Z`} fill={a} />
					<path d={`M0 ${230 + pick(3, 30)} C 120 ${180 + pick(5, 40)}, 260 ${260 + pick(7, 20)}, 400 ${210 + pick(9, 30)} V300 H0 Z`} fill={b} opacity="0.7" />
				</g>
			)}
			{variant === 4 && ( // soft arch window
				<g opacity="0.5">
					<path d={`M ${110 + pick(2, 30)} 260 V 150 a ${90 - pick(4, 20)} ${90 - pick(4, 20)} 0 0 1 ${180 - pick(4, 40)} 0 V 260 Z`} fill={a} />
					<circle cx={200 + pick(6, 30) - 15} cy={95 + pick(8, 25)} r={18 + pick(10, 14)} fill={b} opacity="0.8" />
				</g>
			)}
			{variant === 5 && ( // banner: rolling layered waves
				<g>
					<path d={`M0 ${160 + pick(2, 40)} C 70 ${110 + pick(4, 50)}, 140 ${190 + pick(6, 30)}, 220 ${150 + pick(8, 40)} S 340 ${120 + pick(10, 40)}, 400 ${150 + pick(12, 30)} V300 H0 Z`} fill={a} opacity="0.3" />
					<path d={`M0 ${205 + pick(3, 30)} C 90 ${165 + pick(5, 35)}, 180 ${235 + pick(7, 20)}, 270 ${200 + pick(9, 30)} S 370 ${180 + pick(11, 30)}, 400 ${205 + pick(13, 25)} V300 H0 Z`} fill={b} opacity="0.4" />
					<path d={`M0 ${250 + pick(15, 20)} C 120 ${225 + pick(17, 20)}, 240 ${270 + pick(19, 15)}, 400 ${245 + pick(21, 20)} V300 H0 Z`} fill={a} opacity="0.35" />
				</g>
			)}
			{variant === 6 && ( // avatar: initials on concentric halos
				<g>
					<circle cx="200" cy="150" r="108" fill={a} opacity="0.15" />
					<circle cx="200" cy="150" r="86" fill={a} opacity="0.25" />
					<circle cx="200" cy="150" r="64" fill={b} opacity="0.3" />
					<text x="200" y="150" textAnchor="middle" dominantBaseline="central" fontFamily="var(--font-serif)" fontSize="80" fontWeight="600" fill="var(--foreground)" opacity="0.75">
						{initials || '·'}
					</text>
				</g>
			)}
		</svg>
	)
}
