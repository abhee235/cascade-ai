import { useEffect, useRef, useState } from 'react'
import { Streamdown } from 'streamdown'
import { Loader2, RefreshCw, Square } from 'lucide-react'
import { useStore } from '../../lib/store'
import { ActivityCard } from './ActivityCard'
import { Button } from '../ui/button'

export function ChatPanel() {
  const { items, streaming, status, recovering, busy, connected, activeId, submit, stop } = useStore()
  const [input, setInput] = useState('')
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [items, streaming, status, recovering])

  const onSend = () => {
    submit(input)
    setInput('')
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {items.map((it, i) => (
          <ActivityCard key={i} item={it} />
        ))}

        {streaming && (
          <div className="my-2 rounded-lg bg-card/50 px-3 py-2">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">assistant</div>
            <div className="prose prose-invert prose-sm max-w-none">
              <Streamdown>{streaming.text}</Streamdown>
            </div>
          </div>
        )}

        {recovering && (
          <div className="my-2 flex items-center gap-2 rounded-lg border border-yellow-700/50 bg-yellow-900/20 px-3 py-2 text-xs text-yellow-200">
            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            {recovering.reason === 'overflow' ? 'Context too large — compacting and retrying…' : "Can't reach the model — reconnecting…"}
            <span className="opacity-60">attempt {recovering.attempt}</span>
          </div>
        )}

        {status && !streaming && !recovering && (
          <div className="flex items-center gap-2 px-2 py-1.5 text-xs italic text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> {status}
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="flex gap-2 border-t border-border p-3">
        <textarea
          className="flex-1 resize-none rounded-md border border-input bg-card px-3 py-2 text-sm outline-none focus:border-ring"
          rows={2}
          placeholder={connected ? 'Ask Cascade…' : 'connecting to server…'}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              onSend()
            }
          }}
        />
        {busy ? (
          <Button variant="destructive" onClick={stop}>
            <Square className="h-3.5 w-3.5" /> Stop
          </Button>
        ) : (
          <Button onClick={onSend} disabled={!connected || !activeId}>
            Send
          </Button>
        )}
      </div>
    </div>
  )
}
