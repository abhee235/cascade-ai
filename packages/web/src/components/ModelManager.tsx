// ModelManager.tsx — provider/model management (ADR-067). A WIDE, two-pane master-detail panel, reused by
// the dialog and Settings. LEFT rail: your curated models (the picker list) + the provider menu with API keys.
// RIGHT pane: the selected model's full config — capabilities, and sliders for context window, output cap, and
// sampling (temperature / top-P / top-K) — OR the "add a model" flow (manual id or browse the full catalog).
// The composer picker only ever shows "your models"; the entire catalog lives ONLY here.
//
// Typography: 14px (text-sm) is the baseline everywhere; 12px (text-xs) only for eyebrows/badges/hints.
// Nothing smaller. Numeric params are sliders, never bare number inputs.

import { type CSSProperties, useEffect, useState } from 'react'
import { Check, Cpu, Eye, EyeOff, KeyRound, Plus, Search, Trash2, X } from 'lucide-react'
import type { EnabledModelInfo, ModelLimits } from '@cascade/app-protocol'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'

const fmtCtx = (n?: number) => (n === undefined ? '' : n >= 1_048_576 ? `${+(n / 1_048_576).toFixed(n % 1_048_576 ? 1 : 0)}M` : n >= 1024 ? `${Math.round(n / 1024)}K` : String(n))
// Client-side fallback when the server hasn't sent limits yet (matches modelSpecs.DEFAULT_LIMITS).
const FALLBACK_LIMITS: ModelLimits = { contextMax: 262_144, outputMax: 8_192, tempMax: 2, topK: true }
// Context-window slider stops: powers of two from 4K up to the model's max (inclusive), à la LM Studio.
const ctxStops = (max: number) => {
	const stops: number[] = []
	for (let v = 4096; v < max; v *= 2) stops.push(v)
	stops.push(max)
	return stops
}
const CAP_LABEL: Record<string, string> = { tools: 'Tools', vision: 'Vision', thinking: 'Thinking' }
const capBadges = (caps?: string[]) =>
	(caps ?? [])
		.filter((c) => c !== 'completion')
		.map((c) => (
			<span key={c} className="rounded bg-secondary px-1.5 py-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				{CAP_LABEL[c] ?? c}
			</span>
		))

type Selection = { provider: string; model: string } | { add: true } | null

export function ModelManager() {
	const serverInfo = useStore((s) => s.serverInfo)
	const enabled = useStore((s) => s.enabledModels)
	const modelInfo = useStore((s) => s.modelInfo)
	const fetchModelInfo = useStore((s) => s.fetchModelInfo)
	const setModel = useStore((s) => s.setModel)
	const removeModel = useStore((s) => s.removeModel)

	const providers = serverInfo?.providers ?? []
	const isActive = (p: string, m: string) => serverInfo?.provider === p && serverInfo?.model === m

	// Selection: an enabled model (→ detail/config) or the add flow. Default to the active model.
	const [sel, setSel] = useState<Selection>(null)
	useEffect(() => {
		if (sel === null && enabled.length) setSel(enabled.find((e) => isActive(e.provider, e.model)) ?? enabled[0])
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [enabled])

	// Load capabilities/detected-context for whichever model is selected (drives badges + slider defaults).
	useEffect(() => {
		if (sel && 'provider' in sel && !modelInfo[`${sel.provider}/${sel.model}`]) fetchModelInfo(sel.provider, sel.model)
	}, [sel, modelInfo, fetchModelInfo])

	const selectedModel = sel && 'provider' in sel ? enabled.find((e) => e.provider === sel.provider && e.model === sel.model) : undefined

	return (
		<div className="flex min-h-0 flex-1">
			{/* ── LEFT RAIL: your models + providers ─────────────────────────────── */}
			<aside className="flex w-64 shrink-0 flex-col overflow-y-auto border-r border-border bg-muted/20">
				<div className="flex items-center justify-between px-4 pb-2 pt-4">
					<h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Your models</h3>
					<span className="text-xs text-muted-foreground">{enabled.length}</span>
				</div>
				<div className="flex flex-col gap-0.5 px-2">
					{enabled.length === 0 && <div className="px-2 py-3 text-center text-sm text-muted-foreground">No models yet — add one below.</div>}
					{enabled.map((em) => {
						const active = isActive(em.provider, em.model)
						const selected = sel && 'provider' in sel && sel.provider === em.provider && sel.model === em.model
						return (
							<button
								key={`${em.provider}/${em.model}`}
								type="button"
								onClick={() => setSel({ provider: em.provider, model: em.model })}
								className={cn('group flex items-center gap-2 rounded-md px-2 py-2 text-left text-sm', selected ? 'bg-accent' : 'hover:bg-accent/50')}
							>
								{active ? <Check className="h-4 w-4 shrink-0 text-primary" /> : <span className="w-4 shrink-0" />}
								<span className="min-w-0 flex-1 truncate">
									<span className="block truncate font-medium">{em.model}</span>
									<span className="block truncate text-xs text-muted-foreground">
										{em.provider}
										{em.contextWindow ? ` · ${fmtCtx(em.contextWindow)} ctx` : ''}
									</span>
								</span>
							</button>
						)
					})}
				</div>

				<div className="px-3 py-3">
					<button
						type="button"
						onClick={() => setSel({ add: true })}
						className={cn('flex w-full items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium shadow-sm', sel && 'add' in sel ? 'bg-primary/90 text-primary-foreground' : 'bg-primary text-primary-foreground hover:bg-primary/90')}
					>
						<Plus className="h-4 w-4" /> Add model
					</button>
				</div>

				<div className="mt-auto border-t border-border px-4 pb-4 pt-3">
					<h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Providers</h3>
					<div className="flex flex-col gap-1.5">
						{providers.map((pr) => (
							<div key={pr.id} className="flex items-center gap-2 text-sm">
								<Cpu className="h-4 w-4 shrink-0 text-muted-foreground" />
								<span className="flex-1 capitalize">{pr.id}</span>
								<span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', pr.configured || pr.id === 'ollama' ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground')}>{pr.id === 'ollama' ? 'local' : pr.configured ? 'key set' : 'no key'}</span>
							</div>
						))}
					</div>
				</div>
			</aside>

			{/* ── RIGHT PANE: detail/config or add flow (fixed-height dialog handles scroll) ── */}
			<div className="min-w-0 flex-1 overflow-y-auto p-6">
				{sel && 'add' in sel ? (
					<AddModelPane onAdded={(p, m) => setSel({ provider: p, model: m })} />
				) : selectedModel ? (
					<ModelDetail key={`${selectedModel.provider}/${selectedModel.model}`} em={selectedModel} info={modelInfo[`${selectedModel.provider}/${selectedModel.model}`]} active={isActive(selectedModel.provider, selectedModel.model)} onActivate={() => setModel(selectedModel.provider, selectedModel.model)} onRemove={() => { removeModel(selectedModel.provider, selectedModel.model); setSel(null) }} />
				) : (
					<div className="grid h-full place-items-center text-sm text-muted-foreground">Select a model, or add one.</div>
				)}
			</div>
		</div>
	)
}

// ── Detail + advanced config for one enabled model ──────────────────────────
function ModelDetail(props: { em: EnabledModelInfo; info?: { capabilities: string[]; contextWindow?: number; limits?: ModelLimits }; active: boolean; onActivate: () => void; onRemove: () => void }) {
	const { em, info, active, onActivate, onRemove } = props
	const setModelParams = useStore((s) => s.setModelParams)
	const providers = useStore((s) => s.serverInfo?.providers ?? [])
	const providerCfg = providers.find((p) => p.id === em.provider)

	// Per-model ceilings (official spec table, server-supplied). A saved override beyond a ceiling still fits
	// on the slider so we never clip the user's own value.
	const lim = info?.limits ?? FALLBACK_LIMITS
	const outMax = Math.max(lim.outputMax, em.maxOutputTokens ?? 0)
	const tempMax = Math.max(lim.tempMax, em.temperature ?? 0)

	// Local draft ('' = Auto/backend default) so dragging feels immediate; commit on Save.
	const keys = ['contextWindow', 'maxOutputTokens', 'temperature', 'topP', 'topK'] as const
	const snapshot = () => ({
		contextWindow: em.contextWindow?.toString() ?? '',
		maxOutputTokens: em.maxOutputTokens?.toString() ?? '',
		temperature: em.temperature?.toString() ?? '',
		topP: em.topP?.toString() ?? '',
		topK: em.topK?.toString() ?? '',
	})
	const [draft, setDraft] = useState<Record<string, string>>(snapshot)
	useEffect(() => setDraft(snapshot()), [em]) // eslint-disable-line react-hooks/exhaustive-deps
	const set = (k: string, v: string) => setDraft((d) => ({ ...d, [k]: v }))

	const anyDirty = keys.some((k) => (draft[k] ?? '') !== (em[k]?.toString() ?? ''))
	const num = (s: string) => {
		const t = s.trim()
		return t === '' || !Number.isFinite(Number(t)) ? undefined : Number(t)
	}
	const save = () => setModelParams(em.provider, em.model, { contextWindow: num(draft.contextWindow), maxOutputTokens: num(draft.maxOutputTokens), temperature: num(draft.temperature), topP: num(draft.topP), topK: num(draft.topK) })

	return (
		<div className="flex flex-col gap-6">
			{/* header */}
			<div className="flex items-start gap-3">
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<h2 className="truncate text-lg font-semibold">{em.model}</h2>
						{active && <span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary">Active</span>}
					</div>
					<div className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
						<span className="capitalize">{em.provider}</span>
						{info?.contextWindow ? <span>· {fmtCtx(info.contextWindow)} context (detected)</span> : null}
					</div>
					{/* reserve height so late-loading capability badges don't shift the layout */}
					<div className="mt-2 flex min-h-6 flex-wrap items-center gap-1">{capBadges(info?.capabilities)}</div>
				</div>
				<button type="button" onClick={onActivate} disabled={active} className={cn('shrink-0 rounded-md px-3 py-2 text-sm font-medium', active ? 'cursor-default bg-muted text-muted-foreground' : 'bg-primary text-primary-foreground hover:bg-primary/90')}>
					{active ? 'Active' : 'Set active'}
				</button>
			</div>

			{/* parameters — sliders */}
			<section className="flex flex-col gap-6">
				<h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Parameters</h3>

				<ContextSlider value={draft.contextWindow ?? ''} detected={info?.contextWindow} max={lim.contextMax} onChange={(v) => set('contextWindow', v)} />

				<SliderField label="Max output tokens" value={draft.maxOutputTokens ?? ''} onChange={(v) => set('maxOutputTokens', v)} min={256} max={outMax} step={256} fallback={Math.min(4096, outMax)} format={(n) => n.toLocaleString()} note="Cap on tokens generated per turn (num_predict / max_tokens)." />

				<div className="grid grid-cols-2 gap-x-8 gap-y-6">
					<SliderField label="Temperature" value={draft.temperature ?? ''} onChange={(v) => set('temperature', v)} min={0} max={tempMax} step={0.05} fallback={Math.min(0.7, tempMax)} format={(n) => n.toFixed(2)} note="Higher = more random." />
					<SliderField label="Top P" value={draft.topP ?? ''} onChange={(v) => set('topP', v)} min={0} max={1} step={0.01} fallback={1} format={(n) => n.toFixed(2)} note="Nucleus sampling." />
					{lim.topK && <SliderField label="Top K" value={draft.topK ?? ''} onChange={(v) => set('topK', v)} min={0} max={100} step={1} fallback={40} format={(n) => String(n)} note="Sampling breadth (local/Ollama)." />}
				</div>

				<div className="flex items-center gap-3">
					<button type="button" onClick={save} disabled={!anyDirty} className={cn('rounded-md px-4 py-2 text-sm font-medium', anyDirty ? 'bg-primary text-primary-foreground hover:bg-primary/90' : 'bg-muted text-muted-foreground')}>
						Save parameters
					</button>
					{anyDirty && (
						<button type="button" onClick={() => setDraft(snapshot())} className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:text-foreground">
							Revert
						</button>
					)}
					<span className="ml-auto text-xs text-muted-foreground">Auto = backend default. Applies live to the next turn.</span>
				</div>
			</section>

			{/* provider key */}
			{em.provider !== 'ollama' && <ProviderKey provider={em.provider} configured={!!providerCfg?.configured} />}

			<div className="border-t border-border pt-4">
				<button type="button" onClick={onRemove} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-destructive">
					<Trash2 className="h-4 w-4" /> Remove from your models
				</button>
			</div>
		</div>
	)
}

// A labelled slider with a value readout and an Auto (backend-default) state. Empty value ⇒ Auto: the thumb
// rests at `fallback`, muted, and dragging commits a concrete value; the ✕ clears back to Auto.
function SliderField(props: { label: string; value: string; onChange: (v: string) => void; min: number; max: number; step: number; fallback: number; format: (n: number) => string; note?: string }) {
	const isAuto = props.value.trim() === ''
	const n = isAuto ? props.fallback : Number(props.value)
	const pct = props.max > props.min ? Math.min(100, Math.max(0, ((n - props.min) / (props.max - props.min)) * 100)) : 0
	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-baseline justify-between">
				<span className="text-sm font-medium">{props.label}</span>
				<span className="flex items-center gap-2">
					<span className={cn('text-sm tabular-nums', isAuto ? 'text-muted-foreground' : 'font-semibold')}>{isAuto ? 'Auto' : props.format(n)}</span>
					{!isAuto && (
						<button type="button" onClick={() => props.onChange('')} title="Reset to backend default" className="text-muted-foreground hover:text-foreground">
							<X className="h-4 w-4" />
						</button>
					)}
				</span>
			</div>
			<input type="range" min={props.min} max={props.max} step={props.step} value={n} onChange={(e) => props.onChange(e.target.value)} className="param-slider" style={{ '--pct': `${pct}%` } as CSSProperties} />
			<div className="flex justify-between text-xs tabular-nums text-muted-foreground">
				<span>{props.format(props.min)}</span>
				<span>{props.format(props.max)}</span>
			</div>
			{props.note && <span className="text-xs text-muted-foreground">{props.note}</span>}
		</div>
	)
}

// Context window is a discrete power-of-2 slider with tick labels (à la LM Studio), ranging up to the model's
// OFFICIAL max. Off-grid saved values still show their exact size in the readout; the thumb snaps to nearest.
function ContextSlider(props: { value: string; detected?: number; max: number; onChange: (v: string) => void }) {
	const stops = ctxStops(props.max)
	const isAuto = props.value.trim() === ''
	const raw = isAuto ? (props.detected ?? stops[Math.min(stops.length - 1, Math.max(0, stops.length - 2))]) : Number(props.value)
	const nearest = stops.reduce((best, s, i) => (Math.abs(s - raw) < Math.abs(stops[best] - raw) ? i : best), 0)
	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-baseline justify-between">
				<span className="text-sm font-medium">Context window</span>
				<span className="flex items-center gap-2">
					<span className={cn('text-sm tabular-nums', isAuto ? 'text-muted-foreground' : 'font-semibold')}>{isAuto ? 'Auto' : `${fmtCtx(raw)} tokens`}</span>
					{!isAuto && (
						<button type="button" onClick={() => props.onChange('')} title="Reset to backend default" className="text-muted-foreground hover:text-foreground">
							<X className="h-4 w-4" />
						</button>
					)}
				</span>
			</div>
			<input type="range" min={0} max={stops.length - 1} step={1} value={nearest} onChange={(e) => props.onChange(String(stops[Number(e.target.value)]))} className="param-slider" style={{ '--pct': `${(nearest / (stops.length - 1)) * 100}%` } as CSSProperties} />
			<div className="relative h-4">
				{stops.map((s, i) => (
					<span key={s} className="absolute -translate-x-1/2 text-xs tabular-nums text-muted-foreground" style={{ left: `${(i / (stops.length - 1)) * 100}%` }}>
						{fmtCtx(s)}
					</span>
				))}
			</div>
			<span className="text-xs text-muted-foreground">{props.detected ? `Detected window: ${fmtCtx(props.detected)}. ` : ''}Model max: {fmtCtx(props.max)}.</span>
		</div>
	)
}

function ProviderKey(props: { provider: string; configured: boolean }) {
	const setApiKey = useStore((s) => s.setApiKey)
	const [key, setKey] = useState('')
	const [reveal, setReveal] = useState(false)
	return (
		<section>
			<h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
				<KeyRound className="h-4 w-4" /> {props.provider} API key
			</h3>
			<div className="flex items-center gap-2">
				<div className="relative flex-1">
					<input type={reveal ? 'text' : 'password'} value={key} onChange={(e) => setKey(e.target.value)} placeholder={props.configured ? 'Key set — enter a new one to replace' : `Paste your ${props.provider} API key`} className="w-full rounded-md border border-border bg-background py-2 pl-2.5 pr-9 text-sm outline-none focus:ring-1 focus:ring-ring" />
					<button type="button" onClick={() => setReveal((r) => !r)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
						{reveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
					</button>
				</div>
				<button type="button" disabled={!key.trim()} onClick={() => { setApiKey(props.provider, key); setKey('') }} className={cn('rounded-md px-4 py-2 text-sm font-medium', key.trim() ? 'bg-primary text-primary-foreground hover:bg-primary/90' : 'bg-muted text-muted-foreground')}>
					Save
				</button>
			</div>
			<p className="mt-1.5 text-xs text-muted-foreground">Applies to the running server this session. For persistence set it in <code className="rounded bg-secondary px-1">.env</code>.</p>
		</section>
	)
}

// ── Add-model flow: pick a provider, then type a model id OR browse its catalog ──
function AddModelPane(props: { onAdded: (provider: string, model: string) => void }) {
	const serverInfo = useStore((s) => s.serverInfo)
	const models = useStore((s) => s.models)
	const modelInfo = useStore((s) => s.modelInfo)
	const listModels = useStore((s) => s.listModels)
	const fetchModelInfo = useStore((s) => s.fetchModelInfo)
	const addModel = useStore((s) => s.addModel)
	const enabled = useStore((s) => s.enabledModels)

	const providers = serverInfo?.providers ?? []
	const [provider, setProvider] = useState(providers[0]?.id ?? 'ollama')
	const [modelId, setModelId] = useState('')
	const [query, setQuery] = useState('')

	useEffect(() => {
		if (provider && !models[provider]) listModels(provider)
	}, [provider, models, listModels])
	const loading = !models[provider]
	const catalog = (models[provider] ?? []).filter((m) => m.toLowerCase().includes(query.toLowerCase()))
	useEffect(() => {
		for (const m of catalog.slice(0, 40)) if (!modelInfo[`${provider}/${m}`]) fetchModelInfo(provider, m)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [provider, models, query])
	const isEnabled = (m: string) => enabled.some((e) => e.provider === provider && e.model === m)

	const add = (m: string) => {
		if (!m.trim()) return
		addModel(provider, m.trim(), modelInfo[`${provider}/${m.trim()}`]?.contextWindow)
		props.onAdded(provider, m.trim())
	}

	return (
		<div className="flex h-full flex-col gap-5">
			<div>
				<h2 className="text-lg font-semibold">Add a model</h2>
				<p className="mt-0.5 text-sm text-muted-foreground">Type any model id manually, or pick one from the provider's catalog below.</p>
			</div>

			{/* provider + manual id */}
			<div className="flex flex-col gap-3">
				<label className="flex flex-col gap-1.5">
					<span className="text-sm font-medium">Provider</span>
					<select value={provider} onChange={(e) => { setProvider(e.target.value); setQuery('') }} className="w-full rounded-md border border-border bg-background px-2.5 py-2 text-sm outline-none focus:ring-1 focus:ring-ring">
						{providers.map((p) => (
							<option key={p.id} value={p.id}>
								{p.id}
								{p.id === 'ollama' ? ' (local)' : p.configured ? ' (key set)' : ' (no key)'}
							</option>
						))}
					</select>
				</label>
				<label className="flex flex-col gap-1.5">
					<span className="text-sm font-medium">Model id</span>
					<div className="flex items-center gap-2">
						<input value={modelId} onChange={(e) => setModelId(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add(modelId)} placeholder="e.g. gpt-4.1-mini, qwen36-agentic, llama3.3" className="flex-1 rounded-md border border-border bg-background px-2.5 py-2 text-sm outline-none focus:ring-1 focus:ring-ring" />
						<button type="button" disabled={!modelId.trim()} onClick={() => add(modelId)} className={cn('rounded-md px-4 py-2 text-sm font-medium', modelId.trim() ? 'bg-primary text-primary-foreground hover:bg-primary/90' : 'bg-muted text-muted-foreground')}>
							Add
						</button>
					</div>
				</label>
			</div>

			{/* catalog browse — fills remaining height so its own scroll never resizes the pane */}
			<section className="flex min-h-0 flex-1 flex-col">
				<div className="mb-2 flex items-center justify-between">
					<h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{provider} catalog</h3>
					<div className="relative w-48">
						<Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
						<input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter…" className="w-full rounded-md border border-border bg-background py-1.5 pl-8 pr-2 text-sm outline-none focus:ring-1 focus:ring-ring" />
					</div>
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border p-1">
					{loading ? (
						// skeleton rows reserve height while the catalog loads (no layout shift)
						<div className="flex flex-col gap-0.5">
							{Array.from({ length: 8 }).map((_, i) => (
								<div key={i} className="flex items-center gap-2 px-2 py-2">
									<div className="h-4 flex-1 animate-pulse rounded bg-muted" />
									<div className="h-4 w-10 animate-pulse rounded bg-muted" />
								</div>
							))}
						</div>
					) : catalog.length === 0 ? (
						<div className="px-2 py-6 text-center text-sm text-muted-foreground">No matches — type the id above to add it manually.</div>
					) : (
						catalog.slice(0, 100).map((m) => {
							const info = modelInfo[`${provider}/${m}`]
							const added = isEnabled(m)
							return (
								<div key={m} className="flex items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-accent/50">
									<span className="min-w-0 flex-1 truncate">{m}</span>
									<span className="w-10 shrink-0 text-right tabular-nums text-muted-foreground">{fmtCtx(info?.contextWindow)}</span>
									<span className="flex shrink-0 gap-1">{capBadges(info?.capabilities)}</span>
									<button type="button" disabled={added} onClick={() => add(m)} className={cn('flex h-7 shrink-0 items-center gap-1 rounded px-2 text-xs font-medium', added ? 'cursor-default text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground')}>
										{added ? <><Check className="h-4 w-4" /> Added</> : <><Plus className="h-4 w-4" /> Add</>}
									</button>
								</div>
							)
						})
					)}
				</div>
			</section>
		</div>
	)
}
