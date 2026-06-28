import { useEffect, useRef, useState } from 'react'
import { Streamdown } from 'streamdown'
import { ArrowUp, FileText, Loader2, Paperclip, RefreshCw, Square, X } from 'lucide-react'
import { useStore } from '@/lib/store'
import { ActivityCard } from './ActivityCard'
import { ChatHeader } from './ChatHeader'
import { cn } from '@/lib/utils'

// An attachment staged in the composer (M11): images go to the model as data-URIs; text/code files are
// injected into the message as fenced context (works with any model).
type Attachment = { id: string; name: string; kind: 'image' | 'text'; dataUrl?: string; text?: string }
const TEXT_EXT = /\.(txt|md|markdown|json|jsonc|ya?ml|toml|csv|tsv|html?|css|scss|jsx?|tsx?|mjs|cjs|py|rb|go|rs|java|kt|c|h|cpp|cs|php|sh|sql|env|gitignore|prisma|graphql|vue|svelte)$/i

export function ChatPanel() {
  const { items, streaming, status, recovering, busy, connected, activeId, submit, stop, composerDraft, setComposerDraft } = useStore()
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [dragging, setDragging] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

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

  const addFiles = (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      const id = `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 6)}`
      if (file.type.startsWith('image/')) {
        const reader = new FileReader()
        reader.onload = () => setAttachments((a) => [...a, { id, name: file.name, kind: 'image', dataUrl: String(reader.result) }])
        reader.readAsDataURL(file)
      } else if (file.type.startsWith('text/') || TEXT_EXT.test(file.name)) {
        const reader = new FileReader()
        reader.onload = () => setAttachments((a) => [...a, { id, name: file.name, kind: 'text', text: String(reader.result).slice(0, 100_000) }])
        reader.readAsText(file)
      }
      // other binary types are ignored (no model path)
    }
  }
  const removeAttachment = (id: string) => setAttachments((a) => a.filter((x) => x.id !== id))

  const onSend = () => {
    // Text/code files become fenced context prepended to the message; images go to the model as data-URIs.
    const textFiles = attachments.filter((a) => a.kind === 'text')
    const context = textFiles.map((f) => `Attached file \`${f.name}\`:\n\`\`\`\n${f.text}\n\`\`\``).join('\n\n')
    const text = context ? `${context}${input.trim() ? `\n\n${input.trim()}` : ''}` : input
    const images = attachments.filter((a) => a.kind === 'image').map((a) => a.dataUrl!).filter(Boolean)
    submit(text, images.length ? images : undefined)
    setInput('')
    setAttachments([])
    if (taRef.current) taRef.current.style.height = 'auto'
  }

  const canSend = (!!input.trim() || attachments.length > 0) && connected && !!activeId

  return (
    <div className="flex h-full flex-col text-sm">
      <ChatHeader />
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
        <div
          className={cn(
            'relative flex flex-col gap-2 rounded-2xl border bg-card px-3 py-2.5 shadow-sm transition-colors focus-within:border-ring focus-within:ring-1 focus-within:ring-ring',
            dragging ? 'border-primary ring-1 ring-primary' : 'border-input',
          )}
          onDragOver={(e) => {
            e.preventDefault()
            if (!dragging) setDragging(true)
          }}
          onDragLeave={(e) => {
            if (e.currentTarget === e.target) setDragging(false)
          }}
          onDrop={(e) => {
            e.preventDefault()
            setDragging(false)
            if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files)
          }}
        >
          {dragging && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-primary/10 text-xs font-medium text-primary">
              Drop images or files to attach
            </div>
          )}

          {/* Staged attachment chips */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {attachments.map((a) => (
                <div key={a.id} className="group relative flex items-center gap-1.5 rounded-lg border border-border bg-background py-1 pl-1 pr-2 text-xs">
                  {a.kind === 'image' ? (
                    <img src={a.dataUrl} alt={a.name} className="h-7 w-7 rounded object-cover" />
                  ) : (
                    <span className="flex h-7 w-7 items-center justify-center rounded bg-accent">
                      <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                    </span>
                  )}
                  <span className="max-w-[120px] truncate text-muted-foreground">{a.name}</span>
                  <button type="button" title="Remove" onClick={() => removeAttachment(a.id)} className="text-muted-foreground hover:text-red-500">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <input
            ref={fileRef}
            type="file"
            multiple
            accept="image/*,text/*,.md,.json,.ts,.tsx,.js,.jsx,.css,.html,.py,.go,.rs,.java,.yaml,.yml,.sql,.sh"
            className="hidden"
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files)
              e.target.value = '' // allow re-selecting the same file
            }}
          />
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
              title="Attach files or images"
              onClick={() => fileRef.current?.click()}
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
