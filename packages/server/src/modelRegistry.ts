// modelRegistry.ts — the ENABLED models (ADR-067). The dropdown shows ONLY these — a small curated list,
// not a provider's entire /v1/models catalog. The manager browses the full catalog (listModels) and ADDS
// models here. Persisted to a gitignored JSON file so a user's picks survive restarts; per-model context
// window override rides along and is applied on switch.

import type { ConfigStore } from '@cascade/storage'

export interface EnabledModel {
  provider: string
  model: string
  /** Optional context-window override (tokens) applied when this model is activated. */
  contextWindow?: number
  /** Cap on generated tokens per turn (Ollama num_predict / OpenAI max_tokens). */
  maxOutputTokens?: number
  /** Sampling temperature (0–2). Omit ⇒ backend default. */
  temperature?: number
  /** Nucleus sampling (0–1). Omit ⇒ backend default. */
  topP?: number
  /** Top-K sampling (Ollama-native). Omit ⇒ backend default. */
  topK?: number
  repeatPenalty?: number
  presencePenalty?: number
  /** TASK-thinking-control: reasoning-effort knob for thinking-capable models. Omit ⇒ model default. */
  thinking?: 'off' | 'low' | 'medium' | 'high'
  /** ADR-076: custom OpenAI-compatible endpoint (rented vLLM/SGLang/remote Ollama). When set, the switch sends
   *  this baseUrl to createProvider instead of the provider-id default — so a remote GPU is configured entirely
   *  from the Model Manager, no .env edit or restart. */
  baseUrl?: string
  /** ADR-076: the endpoint's API key. Persisted here (gitignored models.json) so it survives a restart, but
   *  STRIPPED before the list is sent to the client — the browser only ever learns `hasKey`, never the value. */
  apiKey?: string
  /** ADR-077: the endpoint's WIRE PROTOCOL. 'ollama' forces the native /api/chat adapter (which reports
   *  prefill/decode/load timings); omitted ⇒ the generic OpenAI-compatible /v1 path. Only meaningful with a
   *  custom baseUrl — the built-in provider ids already pick their own adapter. */
  api?: 'openai' | 'ollama'
}

/** The editable per-model params (everything on EnabledModel except its identity). */
export type ModelParams = Omit<EnabledModel, 'provider' | 'model'>

/** Seed set — a few sane defaults across the configured providers. The user curates from here. */
const DEFAULTS: EnabledModel[] = [
  { provider: 'openai', model: 'gpt-5.6-luna' },
  { provider: 'openai', model: 'gpt-4.1' },
  { provider: 'ollama', model: 'qwen36-agentic' },
]

/** WHICH enabled model is currently selected. Kept in its OWN file, not folded into models.json, so the
 *  user's curated list needs no migration and a corrupt selection can never cost them the list. */
export interface ActiveModel {
  provider: string
  model: string
  /** Only meaningful for custom/unknown provider ids, where the endpoint isn't derivable from the id. */
  baseUrl?: string
}

// ADR-081: persistence moved behind ConfigStore, but the READ API stays SYNCHRONOUS on purpose.
//
// Every getter here is called from a request handler or a session factory — `enabledMcpServers` is even a
// thunk handed to createSession — and making them async would ripple through ~20 call sites to buy
// nothing: this was already an in-memory cache over a file. So the cache stays, the load happens ONCE at
// startup, and writes are fire-and-forget through the port (the same call it made to writeFileSync,
// which was equally unawaited). Config is a user action, never a hot path.
let store: ConfigStore | undefined
let cache: EnabledModel[] | null = null
let activeCache: ActiveModel | null | undefined // undefined = not read yet, null = nothing persisted

/** Load the registry from the injected store (called once at server startup). */
export async function initModelRegistry(s: ConfigStore): Promise<void> {
  store = s
  const persisted = await s.models()
  if (persisted.length) {
    cache = persisted as EnabledModel[]
  } else if (await s.setting<boolean>('modelsSeeded')) {
    // The user deleted every model on purpose. An empty picker is their choice; respect it.
    cache = []
  } else {
    // First boot: seed the defaults AND persist them, marker-guarded so a later delete sticks.
    //
    // The earlier version kept the seeds in-memory only ("a default the user never chose should not
    // become a row they have to delete") — and that caused measured data loss on the desktop: the seeds
    // exist only while the store is EMPTY, so the first time any single model was selected (persisting
    // that one row), every other model in the picker vanished on the next launch. Rows the user saw and
    // relied on disappearing is strictly worse than rows they can delete once.
    cache = [...DEFAULTS]
    // AWAITED, sequentially — unlike every other registry write. upsertModel is a read-modify-write of one
    // JSON document, so three concurrent seeds race and one loses its update (caught by test: the picker
    // seeded 2 of 3). Init runs once at boot; the hot-path rule does not apply here.
    for (const d of DEFAULTS) await Promise.resolve(s.upsertModel(d)).catch(() => {})
  }
  void Promise.resolve(s.setSetting('modelsSeeded', true)).catch(() => {})
  activeCache = (await s.activeModel()) ?? null
}

/** Persist one model, best-effort. Mirrors the old save(): a write that fails costs persistence, never
 *  the running session. */
const persist = (m: EnabledModel) => void Promise.resolve(store?.upsertModel(m)).catch(() => {})

/** The model the user last switched to, or undefined ⇒ fall back to the env default (first run). Without
 *  this, every server restart silently reverted to CASCADE_PROVIDER/CASCADE_MODEL — measured: a restart
 *  moved a session from the selected local Ollama model back to a paid hosted one, visible only in a label. */
export function activeModel(): ActiveModel | undefined {
  return activeCache ?? undefined
}

export function setActiveModel(a: ActiveModel): void {
  activeCache = a
  void Promise.resolve(store?.setActiveModel(a)).catch(() => {})
}

function load(): EnabledModel[] {
  if (!cache) cache = [...DEFAULTS] // init not run (a test, or a headless embed) — behave as a fresh install
  return cache
}

const same = (a: EnabledModel, provider: string, model: string) => a.provider === provider && a.model === model

/** The enabled models, optionally ensuring `ensure` (the active model) is present so the picker never hides
 *  what's actually running. */
export function enabledModels(ensure?: { provider: string; model: string }): EnabledModel[] {
  const list = load()
  if (ensure && !list.some((m) => same(m, ensure.provider, ensure.model))) return [...list, { provider: ensure.provider, model: ensure.model }]
  return list
}

export function addEnabledModel(provider: string, model: string, contextWindow?: number, baseUrl?: string, apiKey?: string, api?: 'openai' | 'ollama'): void {
  const list = load()
  const existing = list.find((m) => same(m, provider, model))
  if (existing) {
    existing.contextWindow = contextWindow ?? existing.contextWindow
    if (baseUrl !== undefined) existing.baseUrl = baseUrl.trim() || undefined
    if (apiKey) existing.apiKey = apiKey.trim() || undefined // OMITTED key ⇒ keep the stored one (edit-friendly)
    if (api !== undefined) existing.api = api
  } else list.push({ provider, model, contextWindow, baseUrl: baseUrl?.trim() || undefined, apiKey: apiKey?.trim() || undefined, api })
  persist(list.find((m) => same(m, provider, model))!)
}

/** ADR-076/077: the custom endpoint (baseUrl + apiKey + wire protocol) saved for a model, applied on
 *  activation. Empty for the built-in providers (their endpoint derives from the id). Server-side only —
 *  the apiKey is never serialized to the client. */
export function modelEndpointFor(provider: string, model: string): { baseUrl?: string; apiKey?: string; api?: 'openai' | 'ollama' } {
  const m = load().find((e) => same(e, provider, model))
  return { baseUrl: m?.baseUrl, apiKey: m?.apiKey, api: m?.api }
}

/** ADR-076: the enabled list as sent to the CLIENT — the apiKey value is dropped and replaced by `hasKey`. */
export function enabledModelsForClient(ensure?: { provider: string; model: string }): (Omit<EnabledModel, 'apiKey'> & { hasKey?: boolean })[] {
  return enabledModels(ensure).map(({ apiKey, ...rest }) => ({ ...rest, hasKey: !!apiKey }))
}

export function removeEnabledModel(provider: string, model: string): void {
  cache = load().filter((m) => !same(m, provider, model))
  void Promise.resolve(store?.removeModel(provider, model)).catch(() => {})
}

export function setModelContext(provider: string, model: string, contextWindow?: number): void {
  const m = load().find((x) => same(x, provider, model))
  if (m) {
    m.contextWindow = contextWindow
    persist(m)
  } else {
    addEnabledModel(provider, model, contextWindow)
  }
}

/** The context-window override for a model, if the user set one (applied on activation). */
export function modelContextFor(provider: string, model: string): number | undefined {
  return load().find((m) => same(m, provider, model))?.contextWindow
}

/** Merge editable params onto a model (adding it to the enabled set if absent). `undefined` fields clear
 *  the corresponding override; fields simply omitted from `params` are left untouched. */
export function setModelParams(provider: string, model: string, params: ModelParams): void {
  const list = load()
  let m = list.find((x) => same(x, provider, model))
  if (!m) {
    m = { provider, model }
    list.push(m)
  }
  for (const k of ['contextWindow', 'maxOutputTokens', 'temperature', 'topP', 'topK', 'repeatPenalty', 'presencePenalty'] as const) {
    if (k in params) m[k] = params[k]
  }
  persist(m)
}

/** The full param set for a model (applied on activation). Empty object when the model isn't curated. */
export function modelParamsFor(provider: string, model: string): ModelParams {
  const m = load().find((x) => same(x, provider, model))
  if (!m) return {}
  const { provider: _p, model: _m, ...params } = m
  return params
}

