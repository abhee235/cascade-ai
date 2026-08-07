// Kind + status visuals for the Observatory (ADR-081).
//
// Phoenix draws bespoke 20×20 SVGs per kind; we use lucide (already the app's icon set) tinted with the
// same per-kind accent. Same read at a glance, no new asset pipeline, and it inherits the app's stroke
// weight so a span row does not look pasted in from another product.

import { Bot, CircleDashed, Sparkles, Wrench, Zap } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { spanKindColor, tint } from './constants'

const KIND_ICON: Record<string, LucideIcon> = {
  AGENT: Bot,
  LLM: Sparkles,
  TOOL: Wrench,
  CHAIN: Zap, // our CHAIN spans are loop-breaker/gate MARKS — a bolt reads as "something fired"
}

/**
 * A SOLID chip, not a bare glyph.
 *
 * A tinted outline icon disappears against a busy waterfall — the kind is the first thing you scan for,
 * and it has to survive being one of forty rows. A filled square with a knocked-out glyph is how Phoenix
 * does it, and it reads at a glance in both themes: the kind colours are all light enough that a near
 * black glyph stays legible on them, whatever the page behind is doing.
 */
export function SpanKindIcon({ kind, size = 20, plain = false }: { kind: string; size?: number; plain?: boolean }) {
  const Icon = KIND_ICON[kind] ?? CircleDashed
  const c = spanKindColor(kind)
  if (plain) return <Icon style={{ width: size, height: size, color: c }} className="shrink-0" />
  return (
    <span className="flex shrink-0 items-center justify-center rounded-[5px]" style={{ width: size, height: size, backgroundColor: c }}>
      <Icon style={{ width: size * 0.62, height: size * 0.62, color: '#18181b' }} strokeWidth={2.25} />
    </span>
  )
}

/** The pill beside a span's name. Colours derive from ONE accent so adding a kind needs one entry.
 *  Deliberately stronger than a hint: at the previous 14% tint it washed out entirely on light
 *  backgrounds, leaving the row's kind readable only from the icon. */
export function SpanKindToken({ kind }: { kind: string }) {
  const c = spanKindColor(kind)
  return (
    <span
      className="inline-flex h-[18px] shrink-0 items-center rounded-full border px-1.5 text-[10px] font-semibold leading-none"
      style={{ backgroundColor: tint(c, 22), borderColor: tint(c, 55), color: `color-mix(in srgb, ${c} 78%, var(--foreground))` }}
    >
      {kind.toLowerCase()}
    </span>
  )
}

/**
 * Four states, and the fourth is the point: an UNSET status is not a success.
 *  - running (no end yet) → pulsing blue. During a live build this is the common case, and showing it as
 *    a failure — or as done — is what would make the page useless mid-turn.
 *  - error → red.
 *  - ok → green.
 *  - unset → muted. Loop-breaker/gate marks carry no status because they are notices; a green tick beside
 *    "read_loop" reads as "this went well" on exactly the row that says it didn't.
 */
export function StatusDot({ status, running, size = 8 }: { status?: 'ok' | 'error'; running?: boolean; size?: number }) {
  const cls = running ? 'bg-blue-500 animate-pulse' : status === 'error' ? 'bg-red-500' : status === 'ok' ? 'bg-emerald-500' : 'bg-muted-foreground/40'
  const title = running ? 'running' : (status ?? 'note')
  return <span className={`shrink-0 rounded-full ${cls}`} style={{ width: size, height: size }} title={title} />
}
