// DeviceSwitcher.tsx — responsive viewport toggle for the Preview. Switching constrains
// the preview iframe to a real device width so you can see how the built app looks on desktop / tablet /
// phone without leaving Cascade. Lives centered in the project header; only the Preview pane reacts to it.

import { Monitor, Smartphone, Tablet, type LucideIcon } from 'lucide-react'
import { useStore } from '@/lib/store'
import type { PreviewDevice } from '@/lib/types'
import { cn } from '@/lib/utils'

/** Viewport widths the preview is clamped to. Desktop = fill the pane (no clamp). */
export const DEVICE_WIDTH: Record<Exclude<PreviewDevice, 'desktop'>, number> = {
	tablet: 768, // iPad portrait
	mobile: 390, // iPhone 14/15
}

const DEVICES: { id: PreviewDevice; icon: LucideIcon; label: string; hint: string }[] = [
	{ id: 'desktop', icon: Monitor, label: 'Desktop', hint: 'full width' },
	{ id: 'tablet', icon: Tablet, label: 'Tablet', hint: '768px' },
	{ id: 'mobile', icon: Smartphone, label: 'Mobile', hint: '390px' },
]

export function DeviceSwitcher() {
	const device = useStore((s) => s.previewDevice)
	const setDevice = useStore((s) => s.setPreviewDevice)

	return (
		<div className="flex items-center gap-0.5 rounded-lg border border-border bg-card p-0.5 shadow-sm">
			{DEVICES.map((d) => {
				const on = device === d.id
				return (
					<button
						key={d.id}
						type="button"
						onClick={() => setDevice(d.id)}
						title={`${d.label} — ${d.hint}`}
						aria-label={`${d.label} preview`}
						aria-pressed={on}
						className={cn(
							'flex h-7 w-8 items-center justify-center rounded-md transition-colors',
							on ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
						)}
					>
						<d.icon className="h-4 w-4" />
					</button>
				)
			})}
		</div>
	)
}
