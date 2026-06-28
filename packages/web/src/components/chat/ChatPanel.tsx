import { useEffect, useRef, useState } from 'react'
import { Streamdown } from 'streamdown'
import { ArrowUp, Loader2, Paperclip, RefreshCw, Square } from 'lucide-react'
import { useStore } from '@/lib/store'
import { ActivityCard } from './ActivityCard'
import { cn } from '@/lib/utils'

export function ChatPanel() {
  const { items, streaming, status, recovering, busy, connected, activeId, submit, stop, composerDraft, setComposerDraft } = useStore()
  const [input, setInput] = useState('')
  const endRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [items, streaming, status, recovering])

  // M9: "Edit with AI" (and similar) prefill the composer through the store. Adopt the draft, focus, and
  // place the caret at the end so the user just types the change.
  useEffect(() => {
    if (!composerDraft) return
    setInput(composerDraft)
    setComposerDraft('')
    const ta = taRef.current
    if (ta) {
      ta.focus()
      requestAnimationFrame(() => {
        ta.style.height = 'auto'
        ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`
        ta.setSelectionRange(ta.value.length, ta.value.length)
      })
    }
  }, [composerDraft, setComposerDraft])

  // Auto-grow the textarea up to a max height, then scroll.
  const autosize = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }

  const onSend = () => {
    submit(input)
    setInput('')
    if (taRef.current) taRef.current.style.height = 'auto'
  }

  const canSend = !!input.trim() && connected && !!activeId

  return (
    <div className="flex h-full flex-col text-sm">
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {items.map((it, i) => (
          <ActivityCard key={i} item={it} />
        ))}

        {/* Live turn: while only thinking has arrived, show a "Thinking…" pill; once the answer text starts
            streaming, render it as plain flow (no role label) — matches the finished assistant style. */}
        {streaming &&
          (streaming.text ? (
            <div className="my-3 prose prose-sm dark:prose-invert max-w-none">
              <Streamdown>{streaming.text}</Streamdown>
            </div>
          ) : streaming.thinking ? (
            <div className="my-2 flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Thinking…
            </div>
          ) : null)}

        {recovering && (
          <div className="my-2 flex items-center gap-2 rounded-lg border border-yellow-700/50 bg-yellow-900/20 px-3 py-2 text-xs text-yellow-200">
            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            {recovering.reason === 'overflow' ? 'Context too large — compacting and retrying…' : "Can't reach the model — reconnecting…"}
            <span className="opacity-60">attempt {recovering.attempt}</span>
          </div>
        )}

        {/* Persistent "still working" indicator: shows whenever the turn is running and nothing else is
            currently rendering (between tool calls / model steps), so it never looks frozen. */}
        {busy && !streaming && !recovering && (
          <div className="my-1 flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> {status || 'Working…'}
          </div>
        )}
        <div ref={endRef} />
      </div>

      {/* shadcn-style composer: one rounded container, textarea on top, a toolbar row beneath. */}
      <div className="px-3 pb-3 pt-1">
        <div className="flex flex-col gap-2 rounded-2xl border border-input bg-card px-3 py-2.5 shadow-sm transition-colors focus-within:border-ring focus-within:ring-1 focus-within:ring-ring">
          <textarea
            ref={taRef}
            rows={1}
            className="max-h-[200px] min-h-[24px] w-full resize-none bg-transparent text-sm leading-relaxed outline-none placeholder:text-muted-foreground"
            placeholder={connected ? 'Ask Cascade…' : 'connecting to server…'}
            value={input}
            onChange={(e) => {
              setInput(e.target.value)
              autosize(e.target)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                if (canSend) onSend()
              }
            }}
          />
          <div className="flex items-center gap-1">
            <button
              type="button"
              title="Attach (coming soon)"
              className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Paperclip className="h-4 w-4" />
            </button>
            {busy ? (
              <button
                type="button"
                onClick={stop}
                title="Stop"
                className="ml-auto flex h-8 w-8 items-center justify-center rounded-full bg-destructive text-white transition-colors hover:bg-destructive/90"
              >
                <Square className="h-3.5 w-3.5 fill-current" />
              </button>
            ) : (
              <button
                type="button"
                onClick={onSend}
                disabled={!canSend}
                title="Send"
                className={cn(
                  'ml-auto flex h-8 w-8 items-center justify-center rounded-full transition-colors',
                  canSend ? 'bg-primary text-primary-foreground hover:bg-primary/90' : 'bg-muted text-muted-foreground',
                )}
              >
                <ArrowUp className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
