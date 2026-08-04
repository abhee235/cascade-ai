// ModelManagerDialog.tsx — the "Manage models" modal (ADR-067). Thin wrapper around the reusable
// <ModelManager/> content (the same component embeds in Settings). Gated on the store's modelManagerOpen.

import { useStore } from '@/lib/store'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ModelManager } from './ModelManager'

export function ModelManagerDialog() {
	const open = useStore((s) => s.modelManagerOpen)
	const setOpen = useStore((s) => s.setModelManagerOpen)
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogContent className="flex h-[86vh] w-[92vw] max-w-6xl flex-col gap-0 overflow-hidden p-10 sm:p-6 sm:max-w-6xl">
				<DialogHeader className="border-b border-border px-6 py-4">
					<DialogTitle>Models &amp; providers</DialogTitle>
					<DialogDescription>Curate the models in your picker, add models manually or from a provider's catalog, and tune each model's context window, output cap, and sampling. Changes apply live — no restart.</DialogDescription>
				</DialogHeader>
				<ModelManager />
			</DialogContent>
		</Dialog>
	)
}
