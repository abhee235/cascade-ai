// ModelManager.tsx — provider/model management (ADR-067). A WIDE, two-pane master-detail panel, reused by
// the dialog and Settings. LEFT rail: your curated models (the picker list) + the provider menu with API keys.
// RIGHT pane: the selected model's full config — capabilities, and sliders for context window, output cap, and
// sampling (temperature / top-P / top-K) — OR the "add a model" flow (manual id or browse the full catalog).
// The composer picker only ever shows "your models"; the entire catalog lives ONLY here.
//
// Typography: 14px (text-sm) is the baseline everywhere; 12px (text-xs) only for eyebrows/badges/hints.
// Nothing smaller. Numeric params are sliders, never bare number inputs.

import { type CSSProperties, useEffect, useState } from 'react'
import { Check, ChevronRight, Cpu, Eye, EyeOff, KeyRound, Plus, Search, Trash2, X } from 'lucide-react'
import type { EnabledModelInfo, ModelLimits } from '@cascade/app-protocol'
import { useStore } from '@/lib/store'
import { launchCommandFor, LOCAL_PROVIDER_ORIGINS } from '@/lib/launchCommand'
import { cn } from '@/lib/utils'

const fmtCtx = (n?: number) => (n === undefined ? '' : n >= 1_048_576 ? `${+(n / 1_048_576).toFixed(n % 1_048_576 ? 1 : 0)}M` : n >= 1024 ? `${Math.round(n / 1024)}K` : String(n))
// Client-side fallback when the server hasn't sent limits yet (matches modelSpecs.DEFAULT_LIMITS).
const FALLBACK_LIMITS: ModelLimits = { contextMax: 262_144, outputMax: 8_192, tempMax: 2, topK: true }
// Context-window slider stops: powers of two from 4K up to the model's max, PLUS the midpoint between
// each pair (48K, 96K, 192K…), à la LM Studio but at twice the resolution. Pure doubling left holes a
// user actually wants — between 64K and 128K there was nothing, and "some context, not half" is exactly
// the knob for a partial-offload box where the KV cache competes with the weights for VRAM. num_ctx has
// no power-of-two requirement; the discrete stops are UX, not a backend constraint.
const ctxStops = (max: number) => {
	const stops: number[] = []
	for (let v = 4096; v < max; v *= 2) {
		stops.push(v)
		const mid = v * 1.5
		if (mid < max) stops.push(mid)
	}
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
	const keys = ['contextWindow', 'maxOutputTokens', 'temperature', 'topP', 'topK', 'repeatPenalty', 'presencePenalty'] as const
	const snapshot = () => ({
		contextWindow: em.contextWindow?.toString() ?? '',
		maxOutputTokens: em.maxOutputTokens?.toString() ?? '',
		temperature: em.temperature?.toString() ?? '',
		topP: em.topP?.toString() ?? '',
		topK: em.topK?.toString() ?? '',
		repeatPenalty: em.repeatPenalty?.toString() ?? '',
		presencePenalty: em.presencePenalty?.toString() ?? '',
	})
	const [draft, setDraft] = useState<Record<string, string>>(snapshot)
	useEffect(() => setDraft(snapshot()), [em]) // eslint-disable-line react-hooks/exhaustive-deps
	const set = (k: string, v: string) => setDraft((d) => ({ ...d, [k]: v }))

	const anyDirty = keys.some((k) => (draft[k] ?? '') !== (em[k]?.toString() ?? ''))
	const num = (s: string) => {
		const t = s.trim()
		return t === '' || !Number.isFinite(Number(t)) ? undefined : Number(t)
	}
	const save = () => setModelParams(em.provider, em.model, { contextWindow: num(draft.contextWindow), maxOutputTokens: num(draft.maxOutputTokens), temperature: num(draft.temperature), topP: num(draft.topP), topK: num(draft.topK), repeatPenalty: num(draft.repeatPenalty), presencePenalty: num(draft.presencePenalty) })

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
						{/* EFFECTIVE window: a saved override (what the harness actually runs) beats the detected
						    default — otherwise a user who set 131K still saw "32K (detected)" and thought it never
						    applied. "(detected)" shows only when there's no override. */}
						{em.contextWindow ? <span>· {fmtCtx(em.contextWindow)} context</span> : info?.contextWindow ? <span>· {fmtCtx(info.contextWindow)} context (detected)</span> : null}
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
					{lim.topK && <SliderField label="Top K" value={draft.topK ?? ''} onChange={(v) => set('topK', v)} min={0} max={100} step={1} fallback={40} format={(n) => String(n)} note="Sampling breadth (local / self-hosted endpoints)." />}
					{lim.topK && <SliderField label="Repeat penalty" value={draft.repeatPenalty ?? ''} onChange={(v) => set('repeatPenalty', v)} min={1} max={1.5} step={0.01} fallback={1.1} format={(n) => n.toFixed(2)} note="Discourages verbatim repetition — the main anti-loop lever for quantized local models." />}
					{lim.topK && <SliderField label="Presence penalty" value={draft.presencePenalty ?? ''} onChange={(v) => set('presencePenalty', v)} min={0} max={2} step={0.1} fallback={0} format={(n) => n.toFixed(1)} note="Qwen recommends ~1.5 for quantized builds that loop." />}

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

				{em.provider === 'vllm' && <ServeCommandSection command={launchCommandFor('vllm', em.model, { contextWindow: num(draft.contextWindow) ?? em.contextWindow, requiresKey: em.hasKey }) ?? ''} />}
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

/** A copyable shell command. Used wherever the fix for a state is "run this", not "click something". */
function CommandBlock({ command }: { command: string }) {
	const [copied, setCopied] = useState(false)
	return (
		<div className="relative">
			<pre className="overflow-x-auto whitespace-pre-wrap rounded-md border border-border bg-muted/50 px-3 py-2 pr-16 font-mono text-xs leading-relaxed">{command}</pre>
			<button
				type="button"
				className="absolute right-1.5 top-1.5 rounded border border-border bg-background px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
				onClick={() => {
					void navigator.clipboard?.writeText(command)
					setCopied(true)
					setTimeout(() => setCopied(false), 1500)
				}}
			>
				{copied ? 'Copied' : 'Copy'}
			</button>
		</div>
	)
}

/**
 * "How do I run this?" — collapsed by default so the params pane stays uncluttered, per-OS because the
 * honest answer differs: vLLM does not run on native Windows (it runs in WSL, inside whatever env it was
 * installed to), macOS is CPU-only/experimental, and Linux is the primary target. The command itself is
 * built live from the CURRENT draft — dragging the context slider updates --max-model-len before you copy.
 */
function ServeCommandSection({ command }: { command: string }) {
	const [open, setOpen] = useState(false)
	return (
		<div className="mt-4 overflow-hidden rounded-lg border border-border">
			<button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm font-medium hover:bg-accent/50">
				<ChevronRight className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
				How to serve this model
				<span className="ml-auto text-xs font-normal text-muted-foreground">vLLM</span>
			</button>
			{open && (
				<div className="flex flex-col gap-4 border-t border-border px-3 py-3">
					<div className="flex flex-col gap-1.5">
						<span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Windows — runs inside WSL</span>
						<p className="text-xs text-muted-foreground">vLLM has no native Windows build. Activate the environment it was installed in (adjust the path), then serve:</p>
						<CommandBlock command={`wsl
source ~/vllm-env/bin/activate  # your vLLM env
${command}`} />
					</div>
					<div className="flex flex-col gap-1.5">
						<span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Linux</span>
						<CommandBlock command={`source ~/vllm-env/bin/activate  # your vLLM env
${command}`} />
					</div>
					<div className="flex flex-col gap-1.5">
						<span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">macOS — CPU only (experimental)</span>
						<p className="text-xs text-muted-foreground">vLLM on Apple Silicon runs on the CPU — fine for a smoke test, not for real builds.</p>
						<CommandBlock command={command} />
					</div>
					<p className="text-xs text-muted-foreground">First run downloads the model from Hugging Face before anything listens. Wait for “Uvicorn running”, then Retry the catalog.</p>
				</div>
			)}
		</div>
	)
}

// ── Add-model flow: pick a provider, then type a model id OR browse its catalog ──
const CUSTOM_PROVIDER = '__custom__' // ADR-076: dropdown sentinel for "Custom endpoint…" (a remote OpenAI-compatible GPU)

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
	// ADR-076: "Custom endpoint" is just another entry in the Provider dropdown. Selecting it reveals the endpoint
	// fields (label / URL / key / context) and reuses the same Model id + Add below — no separate form, no catalog.
	const isCustom = provider === CUSTOM_PROVIDER
	const [cLabel, setCLabel] = useState('')
	const [cUrl, setCUrl] = useState('')
	const [cKey, setCKey] = useState('')
	const [cCtx, setCCtx] = useState('')
	// ADR-077: which wire protocol the box speaks. A remote OLLAMA reached over the generic /v1 path reports
	// only token counts — picking "Ollama" routes to its native /api/chat so prefill/decode timings come back.
	const [cApi, setCApi] = useState<'openai' | 'ollama'>('openai')

	useEffect(() => {
		if (!isCustom && provider && !models[provider]) listModels(provider)
	}, [provider, models, listModels, isCustom])
	const loading = !models[provider]
	const reachable = useStore((st) => st.modelsReachable)[provider]
	// A LOCAL backend that answered nothing is not "an empty catalog" — nothing is listening. The fix is a
	// command, so show the command (built for this provider) instead of skeletons that resolve to nothing.
	const showLaunchHelp = !isCustom && reachable === false && provider in LOCAL_PROVIDER_ORIGINS
	const catalog = (models[provider] ?? []).filter((m) => m.toLowerCase().includes(query.toLowerCase()))
	useEffect(() => {
		for (const m of catalog.slice(0, 40)) if (!modelInfo[`${provider}/${m}`]) fetchModelInfo(provider, m)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [provider, models, query])
	const isEnabled = (m: string) => enabled.some((e) => e.provider === provider && e.model === m)

	const canAdd = !!modelId.trim() && (!isCustom || (!!cLabel.trim() && !!cUrl.trim()))
	const add = (m: string) => {
		if (!m.trim()) return
		if (isCustom) {
			if (!cLabel.trim() || !cUrl.trim()) return
			addModel(cLabel.trim(), m.trim(), cCtx.trim() ? Number(cCtx) : undefined, cUrl.trim(), cKey.trim() || undefined, cApi)
			props.onAdded(cLabel.trim(), m.trim())
			setCKey('') // don't retain the secret after it's sent
			return
		}
		addModel(provider, m.trim(), modelInfo[`${provider}/${m.trim()}`]?.contextWindow)
		props.onAdded(provider, m.trim())
	}

	return (
		<div className="flex h-full flex-col gap-5">
			<div>
				<h2 className="text-lg font-semibold">Add a model</h2>
				<p className="mt-0.5 text-sm text-muted-foreground">Type any model id manually, or pick one from the provider's catalog below.</p>
			</div>

			{/* provider + manual id. "Custom endpoint" is just another provider choice (ADR-076) — selecting it
			    reveals the endpoint fields and reuses this same Model id + Add. */}
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
						<option value={CUSTOM_PROVIDER}>Custom endpoint (remote GPU)…</option>
					</select>
				</label>

				{isCustom && (
					<div className="grid grid-cols-2 gap-3 bg-muted/30">
						<p className="col-span-2 text-sm text-muted-foreground">A rented vLLM/SGLang box or remote Ollama. Give it a distinct label (not <code>openai</code>); the key is stored on the server, never shown again.</p>
						<label className="flex flex-col gap-1"><span className="text-xs font-medium text-muted-foreground">Provider label</span><input value={cLabel} onChange={(e) => setCLabel(e.target.value)} placeholder="vastai" className="rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring" /></label>
						<label className="flex flex-col gap-1"><span className="text-xs font-medium text-muted-foreground">Context window</span><input value={cCtx} onChange={(e) => setCCtx(e.target.value.replace(/[^0-9]/g, ''))} placeholder="32768" className="rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring" /></label>
						<label className="col-span-2 flex flex-col gap-1">
							<span className="text-xs font-medium text-muted-foreground">Server type</span>
							<select value={cApi} onChange={(e) => setCApi(e.target.value as 'openai' | 'ollama')} className="rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring">
								<option value="openai">OpenAI-compatible (vLLM, SGLang, LM Studio…)</option>
								<option value="ollama">Ollama — native API (adds speed metrics)</option>
							</select>
							<span className="text-xs text-muted-foreground">Pick Ollama for a remote Ollama box: its native API reports prefill/decode timings, which the generic /v1 path omits.</span>
							{/* Wire-parity guard (see core/test/wireParity.test.ts): the OpenAI-compat protocol has NO field for a
							    context window, so this setting only sizes Cascade's planning — the server keeps its own window and
							    silently truncates past it (measured: a remote box at 32k squeezed generation to zero while Cascade
							    planned against 131k). Surface that at setup time, not seven turns into a build. */}
							{cApi === 'openai' && cCtx.trim() && (
								<span className="rounded-md bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-600 dark:text-amber-400">
									⚠ The OpenAI-compatible API cannot enforce a context window — your server must itself be configured for ≥ {Number(cCtx).toLocaleString()} tokens, or it will silently truncate. (For a remote Ollama, pick Server type: Ollama — its native API enforces the window per request.)
								</span>
							)}
						</label>
						<label className="col-span-2 flex flex-col gap-1"><span className="text-xs font-medium text-muted-foreground">Endpoint URL</span><input value={cUrl} onChange={(e) => setCUrl(e.target.value)} placeholder="http://localhost:8000/v1" className="rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring" /></label>
						<label className="col-span-2 flex flex-col gap-1"><span className="text-xs font-medium text-muted-foreground">API key</span><input type="password" value={cKey} onChange={(e) => setCKey(e.target.value)} placeholder="sk-…" className="rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring" /></label>
					</div>
				)}

				<label className="flex flex-col gap-1.5">
					<span className="text-sm font-medium">Model id</span>
					<div className="flex items-center gap-2">
						<input value={modelId} onChange={(e) => setModelId(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add(modelId)} placeholder={isCustom ? 'Qwen/Qwen3.6-27B' : 'e.g. gpt-4.1-mini, qwen36-agentic, llama3.3'} className="flex-1 rounded-md border border-border bg-background px-2.5 py-2 text-sm outline-none focus:ring-1 focus:ring-ring" />
						<button type="button" disabled={!canAdd} onClick={() => add(modelId)} className={cn('rounded-md px-4 py-2 text-sm font-medium', canAdd ? 'bg-primary text-primary-foreground hover:bg-primary/90' : 'bg-muted text-muted-foreground')}>
							Add
						</button>
					</div>
				</label>
			</div>

			{/* catalog browse — hidden for a custom endpoint (no browsable catalog). Fills remaining height so its own scroll never resizes the pane. */}
			{!isCustom && (
			<section className="flex min-h-0 flex-1 flex-col">
				<div className="mb-2 flex items-center justify-between">
					<h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{provider} catalog</h3>
					<div className="relative w-48">
						<Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
						<input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter…" className="w-full rounded-md border border-border bg-background py-1.5 pl-8 pr-2 text-sm outline-none focus:ring-1 focus:ring-ring" />
					</div>
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border p-1">
					{showLaunchHelp ? (
						<div className="flex flex-col gap-2 px-3 py-5 text-sm">
							<p className="font-medium">{provider} isn't running.</p>
							<p className="text-muted-foreground">
								Nothing answered at <code className="rounded bg-muted px-1">{LOCAL_PROVIDER_ORIGINS[provider]}</code>. Start it, then retry:
							</p>
							<CommandBlock command={launchCommandFor(provider, modelId.trim() || undefined) ?? ''} />
							<div>
								<button type="button" onClick={() => listModels(provider)} className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent">
									Retry
								</button>
							</div>
						</div>
					) : loading ? (
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
			)}
		</div>
	)
}
