// SpanDetail.tsx — everything known about one span (ADR-081).
//
// The layout follows what the traces were actually USED for this cycle. Every weak-model diagnosis came
// from a small set of numbers — context window vs input tokens, prefill vs decode, which tool was called
// with what — so those get named fields at the top, and the raw attribute bag goes behind a tab rather
// than being the first thing you read.

import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import type { SpanInfo } from '@cascade/app-protocol'
import { cn } from '@/lib/utils'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { SpanKindIcon, SpanKindToken, StatusDot } from './SpanKind'
import { durationOf, formatDuration, formatRate, formatTokens, isRunning } from './constants'
import { formatJsonish, looksLikeJson } from './format'

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      title="Copy"
      className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0" title={hint}>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="truncate font-mono text-sm">{value}</div>
    </div>
  )
}

/** Long text (a prompt, a tool result) in a scrollable block. Tracer-side truncation at 2000 chars means
 *  this never has to defend against a megabyte, but it still scrolls rather than growing the panel. */
function TextBlock({ label, value, tone }: { label: string; value: string; tone?: 'reasoning' }) {
  const isJson = looksLikeJson(value)
  // Formatted by DEFAULT when the payload is structured: raw is the fallback you reach for to confirm
  // exactly what was stored, not the view you want to read.
  const [formatted, setFormatted] = useState(true)
  const shown = isJson && formatted ? formatJsonish(value) : value

  return (
    <div className={cn('rounded-lg border', tone === 'reasoning' && 'border-violet-500/30 bg-violet-500/5')}>
      <div className={cn('flex items-center gap-2 border-b px-3 py-1.5', tone === 'reasoning' && 'border-violet-500/25')}>
        <span className={cn('flex-1 text-[11px] font-semibold uppercase tracking-wide', tone === 'reasoning' ? 'text-violet-600 dark:text-violet-400' : 'text-muted-foreground')}>{label}</span>
        {isJson && (
          <div className="flex rounded-md border p-0.5">
            {([true, false] as const).map((mode) => (
              <button
                key={String(mode)}
                type="button"
                onClick={() => setFormatted(mode)}
                className={cn('rounded px-1.5 py-0.5 text-[10px] transition-colors', formatted === mode ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')}
              >
                {mode ? 'Formatted' : 'Raw'}
              </button>
            ))}
          </div>
        )}
        {/* Copy always yields the ORIGINAL. The formatted view expands escapes for reading, which makes it
            invalid JSON — handing that to the clipboard would be handing over something that no longer
            parses. You read here; you copy data. */}
        <CopyButton text={value} />
      </div>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-relaxed">{shown}</pre>
    </div>
  )
}

/** Attributes the named fields above already show — hidden from the raw list so it stays scannable. */
const PROMOTED = new Set([
  'input',
  'output',
  'thinking',
  'inputTokens',
  'outputTokens',
  'promptEvalMs',
  'prefillTps',
  'decodeMs',
  'decodeTps',
  'contextWindow',
  'provider',
  'model',
  'latencyMs',
  'durationMs',
  'toolName',
  'cascade.project_id',
  'cascade.model',
])

export function SpanDetail({ span }: { span: SpanInfo | null }) {
  if (!span)
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">Select a span to see its detail.</div>
    )

  const a = span.attributes ?? {}
  const running = isRunning(span)
  const input = typeof a.input === 'string' ? a.input : undefined
  const output = typeof a.output === 'string' ? a.output : undefined
  const thinking = typeof a.thinking === 'string' && a.thinking.trim() ? a.thinking : undefined
  const inTok = a.inputTokens as number | undefined
  const outTok = a.outputTokens as number | undefined
  const window = a.contextWindow as number | undefined
  // Sorted so the span's OWN fields lead and the plumbing (cascade.project_id, chat id…) trails —
  // otherwise the interesting attributes sit below three infrastructure keys on every single span.
  const allAttrs = Object.entries(a).sort(([x], [y]) => Number(x.startsWith('cascade.')) - Number(y.startsWith('cascade.')) || x.localeCompare(y))

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="shrink-0 border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <SpanKindIcon kind={span.kind} size={18} />
          <span className="min-w-0 flex-1 truncate font-semibold">{span.name}</span>
          <SpanKindToken kind={span.kind} />
          <StatusDot status={span.status} running={running} />
        </div>
        {/* Signals that change how you read the row, so they belong beside the name rather than buried in
            the attribute list: the harness had to fix the model's arguments, or a human was asked. */}
        {Boolean(a.argsRepaired || a['cascade.permission_asked']) && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {a.argsRepaired ? <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">arguments repaired</span> : null}
            {a['cascade.permission_asked'] ? <span className="rounded bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-medium text-blue-600 dark:text-blue-400">you were asked · {String(a['cascade.permission'])}</span> : null}
          </div>
        )}
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Duration" value={running ? 'running…' : formatDuration(durationOf(span))} />
          {span.kind === 'LLM' ? (
            <>
              <Stat label="Tokens" value={`${formatTokens(inTok)} → ${formatTokens(outTok)}`} hint="prompt → completion" />
              {/* Context OCCUPANCY, not throughput. Summing tokens across calls looks alarming (344k over a
                  dozen calls) while real occupancy never left a third of the window — this is the ratio
                  that actually predicts compaction. */}
              <Stat
                label="Context"
                value={window ? `${Math.round(((inTok ?? 0) / window) * 100)}% of ${formatTokens(window)}` : '—'}
                hint="how full the window was for THIS call"
              />
              {/* Prefill throughput is the KV-CACHE observable and decode is the model's raw speed — they
                  fail for different reasons, so they get equal billing. Prompt token COUNTS include cached
                  tokens, so a cache MISS shows up only here: ~500 tok/s means a full re-prefill, a hit runs
                  10k+. Duration alone cannot tell those apart. */}
              <Stat
                label="Prefill / decode"
                value={`${a.prefillTps ? `${formatTokens(a.prefillTps as number)}/s` : '—'} · ${a.decodeTps ? `${a.decodeTps}/s` : formatRate(outTok, a.decodeMs as number | undefined)}`}
                hint="prefill tok/s (low ⇒ KV-cache miss) · decode tok/s"
              />
            </>
          ) : (
            <>
              <Stat label="Started" value={new Date(span.startedAt).toLocaleTimeString()} />
              {/* 'note' rather than a defaulted 'ok': a mark carries no status, and claiming success for it
                  is the same mistake the green dot made. */}
              <Stat label="Status" value={running ? 'running' : (span.status ?? 'note')} />
              <Stat label="Span" value={span.spanId} />
            </>
          )}
        </div>
        {span.kind === 'LLM' && (a.promptEvalMs != null || a.model != null) && (
          <div className="mt-2 font-mono text-[11px] text-muted-foreground">
            {a.promptEvalMs != null && `prefill ${formatDuration(a.promptEvalMs as number)} · decode ${formatDuration(a.decodeMs as number | undefined)} · `}
            {a.provider ? `${a.provider}` : ''}
            {a.model ? `/${a.model}` : ''}
            {/* A nonzero load mid-session means the RUNNER was evicted and reloaded — which looks exactly
                like a slow model until you can see this number, so it is called out rather than buried. */}
            {a.modelLoadMs != null && <span className="ml-2 rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-600 dark:text-amber-400">model reloaded ({formatDuration(a.modelLoadMs as number)})</span>}
          </div>
        )}
      </div>

      {/* Body */}
      <Tabs defaultValue="io" className="flex min-h-0 flex-1 flex-col">
        <TabsList className="mx-4 mt-3 w-fit shrink-0">
          <TabsTrigger value="io">Input / Output</TabsTrigger>
          <TabsTrigger value="attrs">Attributes{allAttrs.length ? ` (${allAttrs.length})` : ''}</TabsTrigger>
        </TabsList>

        <TabsContent value="io" className="min-h-0 flex-1 space-y-3 overflow-auto px-4 pb-4">
          {input && <TextBlock label={span.kind === 'TOOL' ? 'Tool input' : span.kind === 'LLM' ? 'Prompt (last messages)' : 'Input'} value={input} />}
          {/* Reasoning FIRST, because it came first and because it is the part that explains the rest. On a
              tool-only turn the output degrades to the tool list, and the thinking that chose those tools is
              the only account of why — precisely the turn you need when a local model goes somewhere odd. */}
          {thinking && <TextBlock label="Reasoning" value={thinking} tone="reasoning" />}
          {output && <TextBlock label={span.kind === 'TOOL' ? 'Tool result' : 'Output'} value={output} />}
          {!input && !output && !thinking && (
            <div className={cn('py-8 text-center text-sm text-muted-foreground')}>
              {running ? 'Still running — output arrives when the span closes.' : 'This span carries no input or output.'}
            </div>
          )}
        </TabsContent>

        <TabsContent value="attrs" className="min-h-0 flex-1 space-y-3 overflow-auto px-4 pb-4">
          {/* ALL of them, like Phoenix's "All Attributes" — this is the raw view, and a raw view that
              hides fields is a trap. The named fields above are a READING of the span; this is the span.
              Promoted keys are dimmed rather than removed, so you can still see the whole record and tell
              at a glance which parts are already summarised for you. */}
          {allAttrs.length ? (
            <div className="divide-y rounded-lg border">
              {allAttrs.map(([k, v]) => {
                const raw = typeof v === 'object' ? JSON.stringify(v) : String(v)
                // Same formatter as the Input/Output blocks: a tool's `input` here is the same escaped
                // one-liner, and it is just as unreadable in a table cell as it was in a block.
                const text = looksLikeJson(raw) ? formatJsonish(raw) : raw
                return (
                  <div key={k} className={cn('grid grid-cols-[minmax(0,11rem)_1fr] gap-3 px-3 py-2', PROMOTED.has(k) && 'opacity-55')}>
                    <span className="truncate font-mono text-xs text-muted-foreground" title={k}>
                      {k}
                    </span>
                    {/* Values can be a whole file (a Write tool's input), so they scroll rather than
                        pushing the rest of the list off the panel. */}
                    <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{text}</pre>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="py-8 text-center text-sm text-muted-foreground">This span carries no attributes.</div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
