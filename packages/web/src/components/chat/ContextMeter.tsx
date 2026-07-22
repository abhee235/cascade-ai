// ContextMeter.tsx — a hairline above the composer showing how full the model's context window is.
//
// The number people reach for is cumulative token spend, and it misleads: a stateless API re-sends the whole
// conversation every call, so the total climbs forever (measured: 344k across 12 calls) while the window was
// never more than a third full. Compaction fires on OCCUPANCY — one prompt against the window — so that is
// what this shows. It doubles as the composer's separator: zero extra vertical space, and the one moment you
// most want it (deciding whether to type more) is the moment you are looking here anyway.

import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'

const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n))

export function ContextMeter() {
	const context = useStore((s) => s.context)
	// No model call yet in this chat ⇒ occupancy is genuinely unknown. Render the plain separator rather than
	// an empty meter, so the line never reads as "0% used".
	if (!context || !context.window) return <div className="mx-3 h-0.5 bg-border" />

	const { used, window: win, auto } = context
	const pct = Math.min(100, (used / win) * 100)
	// Colour by the thresholds that actually govern behaviour, not round numbers: amber once the next call is
	// within reach of the auto-compaction trigger, red once it crosses it (history is about to be rewritten).
	const compactAt = (auto / win) * 100
	const tone = pct >= compactAt ? 'bg-red-500' : pct >= compactAt * 0.8 ? 'bg-amber-500' : 'bg-primary/70'

	return (
		<div
			className="group relative mx-3 h-0.5 bg-border"
			title={`Context: ${used.toLocaleString()} of ${win.toLocaleString()} tokens (${Math.round(pct)}%) — auto-compacts at ${auto.toLocaleString()}`}
		>
			<div className={cn('h-0.5 transition-[width] duration-500', tone)} style={{ width: `${pct}%` }} />
			{/* The numbers stay out of the way until you ask for them — hovering the line is the ask. */}
			<span className="pointer-events-none absolute -top-4 right-0 text-[10px] tabular-nums text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
				{fmt(used)}/{fmt(win)} · {Math.round(pct)}%
			</span>
		</div>
	)
}
