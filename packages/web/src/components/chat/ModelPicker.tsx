// ModelPicker.tsx — the composer's model switcher (ADR-067). Minimal: a small button
// showing `provider · model`; the dropdown opens with "Manage models…" (→ the full manager dialog) then a
// tight list of the ACTIVE provider's models (`provider · model`). The full grid — every provider, keys,
// capabilities — lives in the ModelManager dialog, not here.

import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Cpu, SlidersHorizontal } from 'lucide-react'
import { useStore } from '../../lib/store'
import { cn } from '../../lib/utils'

export function ModelPicker() {
	const serverInfo = useStore((s) => s.serverInfo)
	const enabledModels = useStore((s) => s.enabledModels)
	const setModel = useStore((s) => s.setModel)
	const openManager = useStore((s) => s.setModelManagerOpen)
	const busy = useStore((s) => s.busy)
	const [open, setOpen] = useState(false)
	const ref = useRef<HTMLDivElement>(null)

	const activeProvider = serverInfo?.provider
	const activeModel = serverInfo?.model

	useEffect(() => {
		if (!open) return
		const onDoc = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
		}
		document.addEventListener('mousedown', onDoc)
		return () => document.removeEventListener('mousedown', onDoc)
	}, [open])

	if (!serverInfo) return null

	return (
		<div ref={ref} className="relative">
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				disabled={busy}
				title={busy ? 'Finish the current turn before switching models' : 'Switch model'}
				className={cn('flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors', busy ? 'opacity-50' : 'hover:bg-accent hover:text-foreground')}
			>
				<Cpu className="h-3.5 w-3.5 shrink-0" />
				<span className="max-w-[170px] truncate">{activeProvider ? `${activeProvider} · ${activeModel}` : (activeModel ?? 'model')}</span>
				<ChevronDown className="h-3 w-3 shrink-0" />
			</button>

			{open && (
				<div className="absolute bottom-full left-0 z-50 mb-1 max-h-80 w-64 overflow-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg">
					<button
						type="button"
						onClick={() => {
							openManager(true)
							setOpen(false)
						}}
						className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-md font-medium hover:bg-accent"
					>
						<SlidersHorizontal className="h-3.5 w-3.5 shrink-0" /> Manage models…
					</button>
					<div className="my-1 h-px bg-border" />
					{enabledModels.length === 0 ? (
						<div className="px-2 py-1.5 text-xs text-muted-foreground">No models yet — add some via Manage models.</div>
					) : (
						enabledModels.map((em) => {
							const isActive = activeProvider === em.provider && activeModel === em.model
							return (
								<button
									key={`${em.provider}/${em.model}`}
									type="button"
									onClick={() => {
										setModel(em.provider, em.model)
										setOpen(false)
									}}
									className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-md hover:bg-accent"
								>
									{isActive ? <Check className="h-3 w-3 shrink-0 text-primary" /> : <span className="w-3 shrink-0" />}
									{/* ADR-084 Phase 5: long ids truncate to the SAME string — `hf.co/unsloth/Qw…` and
									    `hf.co/unsloth/Q…` are different models that look identical in this list. */}
									<span className="min-w-0 flex-1 truncate" title={`${em.provider} · ${em.model}`}>
										<span className="text-muted-foreground">{em.provider} · </span>
										{em.model}
									</span>
									{em.contextWindow ? <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{em.contextWindow >= 1024 ? `${Math.round(em.contextWindow / 1024)}K` : em.contextWindow}</span> : null}
								</button>
							)
						})
					)}
				</div>
			)}
		</div>
	)
}
