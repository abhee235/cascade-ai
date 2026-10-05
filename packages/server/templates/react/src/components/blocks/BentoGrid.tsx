import type { ComponentType, ReactNode } from 'react'
import { cn } from '@/lib/utils'

export type BentoTile =
	/** A big visual tile — the anchor of the grid. Give it the widest span. */
	| { kind: 'media'; title: ReactNode; description?: ReactNode; media: ReactNode; span?: 1 | 2; className?: string }
	/** One number that matters. Value is display-sized; label is the quiet caption. `trend`: a few numbers drawn
	 *  as bars under the value — a stat with its shape reads as evidence, not a lone figure in an empty tile. */
	| { kind: 'stat'; value: ReactNode; label: ReactNode; trend?: number[]; span?: 1 | 2; className?: string }
	/** The one filled tile — primary ground, for the section's call to action. Use ONCE per grid. */
	| { kind: 'accent'; title: ReactNode; description?: ReactNode; action?: ReactNode; span?: 1 | 2; className?: string }
	/** Plain content tile with an optional lucide icon. */
	| { kind: 'plain'; icon?: ComponentType<{ className?: string }>; title: ReactNode; description?: ReactNode; span?: 1 | 2; className?: string }

export interface BentoGridProps {
	tiles: BentoTile[]
	/** Columns at md+ (default 3). Tiles may span 2 of them. */
	columns?: 2 | 3 | 4
	className?: string
}

const COLS = { 2: 'md:grid-cols-2', 3: 'md:grid-cols-3', 4: 'md:grid-cols-4' } as const
const SPAN = { 1: '', 2: 'md:col-span-2', 3: 'md:col-span-3', 4: 'md:col-span-4' } as const

/** BENTO GRID — the modern feature/highlight section: tiles of MIXED size and weight instead of a row of
 *  identical cards. Compose 4–7 tiles: one `media` (span 2) as the anchor, one or two `stat`, one `accent`
 *  for the CTA, the rest `plain`. Every tile is token-styled and adapts to the active preset + dark mode.
 *  The LAST tile widens to fill its row — measured (ADR-086 P1): six tiles left the accent alone on a row. */
export function BentoGrid({ tiles, columns = 3, className }: BentoGridProps) {
	const spans = tiles.map((t) => Math.min(columns, t.span ?? 1))
	const rest = spans.reduce((a, b) => a + b, 0) % columns
	if (rest && spans.length) spans[spans.length - 1] = Math.min(columns, spans[spans.length - 1]! + columns - rest)
	return (
		<div data-block="bento-grid" className={cn('grid auto-rows-[minmax(11rem,auto)] gap-4', COLS[columns], className)}>
			{tiles.map((tile, i) => (
				<div
					key={i}
					className={cn(
						'relative flex flex-col overflow-hidden rounded-xl border p-6',
						SPAN[spans[i] as keyof typeof SPAN],
						tile.kind === 'accent' ? 'bg-primary text-primary-foreground' : tile.kind === 'stat' ? 'bg-muted' : 'bg-card',
						tile.kind === 'media' && 'p-0',
						tile.className,
					)}
				>
					{tile.kind === 'media' ? (
						<>
							<div className="relative min-h-[12rem] flex-1 [&>img]:size-full [&>img]:object-cover [&>svg]:size-full">{tile.media}</div>
							<div className="absolute inset-x-0 bottom-0 flex flex-col gap-1 bg-gradient-to-t from-foreground/85 to-transparent p-6 pt-16">
								<h3 className="font-serif text-xl font-semibold text-background">{tile.title}</h3>
								{tile.description ? <p className="text-sm text-background/80">{tile.description}</p> : null}
							</div>
						</>
					) : tile.kind === 'stat' ? (
						// The label on top, the number anchored at the bottom (with its trend): the tile is composed top to
						// bottom instead of one centered figure floating in a tall empty tile.
						<div className="flex flex-1 flex-col justify-between gap-6">
							<span className="text-sm font-medium text-muted-foreground">{tile.label}</span>
							<div className="flex flex-col gap-4">
								<span className="font-serif text-5xl font-semibold leading-none tracking-display md:text-6xl">{tile.value}</span>
								{tile.trend?.length ? (
									// Min–max scaled with a floor: 99.90 → 100.00 must show its shape, not six full bars.
									<div aria-hidden className="flex h-16 items-end gap-1.5">
										{tile.trend.map((v, j, all) => {
											const lo = Math.min(...all), hi = Math.max(...all)
											return <span key={j} className="flex-1 rounded-sm bg-primary/70" style={{ height: `${20 + (hi > lo ? ((v - lo) / (hi - lo)) * 80 : 80)}%` }} />
										})}
									</div>
								) : null}
							</div>
						</div>
					) : tile.kind === 'accent' ? (
						<div className="flex flex-1 flex-col gap-2">
							<h3 className="text-lg font-semibold">{tile.title}</h3>
							{tile.description ? <p className="text-sm text-primary-foreground/80">{tile.description}</p> : null}
							{tile.action ? <div className="mt-auto pt-4">{tile.action}</div> : null}
						</div>
					) : (
						<div className="flex flex-1 flex-col gap-2">
							{tile.icon ? (
								<span className="mb-1 flex size-9 items-center justify-center rounded-lg bg-accent text-accent-foreground">
									<tile.icon className="size-4" />
								</span>
							) : null}
							<h3 className="font-medium">{tile.title}</h3>
							{tile.description ? <p className="text-sm text-muted-foreground">{tile.description}</p> : null}
						</div>
					)}
				</div>
			))}
		</div>
	)
}
