// Observatory design constants (ADR-081).
//
// Colours and tree geometry follow Arize Phoenix, because we spent this whole cycle reading Phoenix
// waterfalls to diagnose weak-model failures — keeping the visual language identical means the in-app
// view reads the same way, with no relearning.
//
// One deliberate divergence: Phoenix (and the reference implementation) shows COST. Cascade's whole point
// is local models, where cost is always $0.00 — a column that never varies is noise. The number that
// actually moves on this hardware is DECODE RATE: measured 2026-07-23, tok/s fell 48→31 as context grew.
// So `formatRate` replaces `formatCost`.

/** Per-kind accent. Only the four kinds SqliteTracer emits are used today; the rest are kept so a new
 *  span kind gets a sensible colour instead of falling back to grey. */
export const SPAN_KIND_COLORS: Record<string, string> = {
  AGENT: '#b0b0b0',
  LLM: '#ffa23b',
  TOOL: '#f7d804',
  CHAIN: '#7cbdfa',
  RETRIEVER: '#42cac3',
  EMBEDDING: '#aeb1ff',
  GUARDRAIL: '#eb6ed8',
}

export const spanKindColor = (kind: string): string => SPAN_KIND_COLORS[kind] ?? SPAN_KIND_COLORS.AGENT

/** Tint helpers. color-mix (not Phoenix's `lch(from …)`) because relative-colour syntax is still uneven
 *  outside Chromium, and the web app is not Electron-only. Same effect, wider support. */
export const tint = (color: string, pct: number) => `color-mix(in srgb, ${color} ${pct}%, transparent)`

/* ── Tree geometry ──
 * Derived from ONE row layout rather than hand-tuned constants, because the hand-tuned set drifted out
 * of agreement with the markup: the elbow ended 26px short of the icon, so a child looked unattached and
 * a SIBLING of a nested agent read as another of its children. Every x below is computed from the same
 * three numbers, so the rails and the row content cannot disagree again.
 *
 *   [ROW_PAD][indent × depth][CHEVRON_W][GAP][icon]…
 */
export const ROW_PAD = 10 // px before the first chevron slot
export const NESTING_INDENT = 20 // px per level
export const CHEVRON_W = 18 // the expand/collapse slot — reserved whether or not a row has children
export const ICON_GAP = 6 // matches gap-1.5 between the chevron slot and the kind icon

/** x of the vertical rule for ancestor level `i` — centred under that level's chevron. */
export const railX = (level: number) => ROW_PAD + level * NESTING_INDENT + CHEVRON_W / 2
/** x where a row's kind icon starts. The elbow runs to here, so a child visibly attaches to its parent. */
export const iconX = (depth: number) => ROW_PAD + depth * NESTING_INDENT + CHEVRON_W + ICON_GAP
/** Width of the elbow joining a row to its parent's rail. */
export const elbowW = (depth: number) => iconX(depth) - railX(depth - 1)

export const CONNECTOR_RADIUS = 8
export const ROW_HALF = 18 // half a row's height — where the elbow turns horizontal
export const TIMELINE_BAR_HEIGHT = 6

/* ── Formatters ── */
export function formatTokens(n: number | undefined): string {
  if (!n) return '—'
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

export function formatDuration(ms: number | undefined | null): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  return `${m}m ${Math.round((ms % 60_000) / 1000)}s`
}

/** Decode throughput — the local-hardware number cost would have occupied. */
export function formatRate(outputTokens?: number, decodeMs?: number): string {
  if (!outputTokens || !decodeMs) return '—'
  return `${Math.round(outputTokens / (decodeMs / 1000))} tok/s`
}

export function formatTimeAgo(epochMs: number): string {
  const s = Math.floor((Date.now() - epochMs) / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

/** A span with no `endedAt` has not finished. During a live turn that is the normal state, not an error —
 *  everything downstream must treat it as "running", never as a zero-duration span. */
export const isRunning = (s: { endedAt?: number }) => s.endedAt == null
export const durationOf = (s: { startedAt: number; endedAt?: number }) => (s.endedAt == null ? null : s.endedAt - s.startedAt)
