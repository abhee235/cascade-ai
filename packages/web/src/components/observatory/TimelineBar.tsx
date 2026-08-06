// TimelineBar.tsx — where a span sits inside its trace (ADR-081).
//
// This bar is the reason a waterfall beats a log: it answers "what was the turn actually WAITING on?"
// without arithmetic. A 60-second turn whose bar is one long orange LLM block is a slow model; the same
// turn as a dense row of yellow TOOL blocks is a thrashing loop. Both look identical in a list of names.

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { SpanInfo } from '@cascade/app-protocol'
import { TIMELINE_BAR_HEIGHT, formatDuration, spanKindColor, tint } from './constants'

export function TimelineBar({ span, traceStart, traceMs }: { span: SpanInfo; traceStart: number; traceMs: number }) {
  const offset = span.startedAt - traceStart
  // A running span has no end. Drawing it to zero width would hide the very span you are waiting on, so it
  // runs to the current edge of the trace instead — which is what "still going" looks like.
  const running = span.endedAt == null
  const duration = running ? Math.max(0, traceMs - offset) : (span.endedAt as number) - span.startedAt

  const left = Math.max(0, Math.min(100, (offset / traceMs) * 100))
  // A floor of 0.75%: a 3ms tool call inside a 60s turn rounds to zero width and vanishes, and "the tool
  // that returned instantly" is often exactly the row you are hunting for.
  const width = Math.max(0.75, Math.min(100 - left, (duration / traceMs) * 100))
  const color = spanKindColor(span.kind)

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="relative w-full overflow-hidden rounded-full bg-muted" style={{ height: TIMELINE_BAR_HEIGHT }}>
          <div
            className="absolute inset-y-0 rounded-full"
            style={{
              left: `${left}%`,
              width: `${width}%`,
              backgroundColor: running ? tint(color, 55) : color,
            }}
          />
        </div>
      </TooltipTrigger>
      <TooltipContent side="top" className="font-mono text-xs">
        <div>start +{formatDuration(offset)}</div>
        <div>{running ? 'running…' : formatDuration(duration)}</div>
      </TooltipContent>
    </Tooltip>
  )
}
