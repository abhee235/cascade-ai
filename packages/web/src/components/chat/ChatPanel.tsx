import { useEffect, useRef, useState } from 'react'
import { Streamdown } from 'streamdown'
import { ArrowUp, FileText, Loader2, Paperclip, RefreshCw, Square, X } from 'lucide-react'
import { useStore } from '@/lib/store'
import type { Item } from '@/lib/types'
import { ActivityCard, ChangeSet } from './ActivityCard'
import { ChatHeader } from './ChatHeader'
import { ContextMeter } from './ContextMeter'
import { ModelPicker } from './ModelPicker'
import { QuestionCard } from './QuestionCard'
import { cn } from '@/lib/utils'

const isFileEdit = (it: Item): it is Extract<Item, { kind: 'tool' }> => it.kind === 'tool' && it.display?.kind === 'fileEdit'
const isTodos = (it: Item) => it.kind === 'tool' && it.display?.kind === 'todos'

// Render the transcript, collapsing a run of consecutive file edits into one "change set" card. TodoWrite
// updates the SAME checklist, so only the latest todos card renders (earlier ones are superseded) — one live
// list instead of a 0/3 → 1/3 → 2/3 stack. Everything else is its own card.
function renderTranscript(items: Item[]) {
  let lastTodo = -1
  for (let i = 0; i < items.length; i++) if (isTodos(items[i])) lastTodo = i
  const out: React.ReactNode[] = []
  for (let i = 0; i < items.length; ) {
    if (isFileEdit(items[i])) {
      let j = i
      while (j < items.length && isFileEdit(items[j])) j++
      const run = items.slice(i, j) as Extract<Item, { kind: 'tool' }>[]
      out.push(run.length > 1 ? <ChangeSet key={i} items={run} /> : <ActivityCard key={i} item={run[0]} />)
      i = j
    } else if (isTodos(items[i]) && i !== lastTodo) {
      i++ // a superseded checklist update — skip it; only the latest todos card renders
    } else if (items[i].kind === 'question') {
      out.push(<QuestionCard key={i} item={items[i] as Extract<Item, { kind: 'question' }>} />) // ADR-043
      i++
    } else {
      out.push(<ActivityCard key={i} item={items[i]} />)
      i++
    }
  }
  return out
}

// An attachment staged in the composer (M11): images go to the model as data-URIs; text/code files are
// injected into the message as fenced context (works with any model).
type Attachment = { id: string; name: string; kind: 'image' | 'text'; dataUrl?: string; text?: string }
const TEXT_EXT = /\.(txt|md|markdown|json|jsonc|ya?ml|toml|csv|tsv|html?|css|scss|jsx?|tsx?|mjs|cjs|py|rb|go|rs|java|kt|c|h|cpp|cs|php|sh|sql|env|gitignore|prisma|graphql|vue|svelte)$/i

// Re-render ~once a second while `active`, so a timer label (elapsed seconds) advances even when no store
// state is changing — the key liveness cue during prompt eval, when the model emits nothing for many seconds.
function useTick(active: boolean) {
  const [, force] = useState(0)
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => force((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [active])
}

// Live reasoning view: streams the tail of the model's thinking as it arrives (auto-scrolled to the bottom),
// with a spinner + ticking elapsed. Replaces the old static "Thinking…" pill so the user can see the model is
// actively reasoning — and roughly how long — instead of guessing whether it's thinking or stuck.
function LiveThinking({ thinking, seconds }: { thinking: string; seconds: number }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight })
  }, [thinking])
  return (
    <div className="my-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
      <div className="mb-1 flex items-center gap-2 text-[13px] leading-[21px] text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span>Thinking…</span>
        {seconds > 0 && <span className="opacity-60 tabular-nums">{seconds}s</span>}
      </div>
      <div ref={ref} className="max-h-24 overflow-y-auto whitespace-pre-wrap text-[13px] leading-[21px] text-muted-foreground/80">
        {thinking}
      </div>
    </div>
  )
}

export function ChatPanel() {
  const { items, streaming, status, recovering, busy, stepStartedAt, sawTokens, connected, activeId, submit, stop, composerDraft, setComposerDraft } = useStore()
  useTick(busy) // re-render ~1×/s while a turn runs so the elapsed timer ticks even with no tokens
  const elapsed = stepStartedAt ? Math.max(0, Math.floor((Date.now() - stepStartedAt) / 1000)) : 0
  // The working-indicator message must reflect the ACTUAL current phase, not one catch-all fallback.
  // (1) While a tool runs, the tool CARD is the activity indicator (its own spinner + "Writing X" /
  //     streaming output) — the generic row is suppressed so it can't contradict it with a stale message
  //     (the reported bug: "Reading your message…" showing under a running Bash/Write/Edit).
  // (2) PREFILL happens before EVERY model call, not just the first — core emits `step` each time, which
  //     resets `sawTokens`, and until the first delta the model is re-reading the entire conversation
  //     (measured: 44K tokens on a local 36B ⇒ many seconds of pure silence). Labelling that "Thinking…"
  //     is a lie the user can feel: nothing is being thought, the prompt is being re-read. So `sawTokens`
  //     alone decides prefill-vs-generating; `workedSinceSubmit` only picks WHICH read it is, because
  //     "reading your message" is only true for the first prompt-eval of a submit.
  const lastItem = items[items.length - 1]
  const toolRunning = lastItem?.kind === 'tool' && lastItem.status === 'running'
  const lastUserIdx = items.map((i) => i.kind).lastIndexOf('user')
  const workedSinceSubmit = lastUserIdx >= 0 && items.slice(lastUserIdx + 1).some((i) => i.kind === 'tool' || i.kind === 'assistant')
  const workingMessage = sawTokens
    ? status || 'Working — running the next step…'
    : workedSinceSubmit
      ? 'Reading the conversation so far…'
      : 'Reading your message and the project context…'
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
      <div className="chat-transcript flex-1 overflow-y-auto px-4 py-3">
        {renderTranscript(items)}

        {/* Live turn: while only thinking has arrived, stream the reasoning tail live (so the user sees the
            model IS working, not frozen); once the answer text starts, render it as plain flow (no role
            label) — matches the finished assistant style. */}
        {streaming &&
          (streaming.text ? (
            <div className="my-3 prose prose-sm dark:prose-invert max-w-none">
              <Streamdown>{streaming.text}</Streamdown>
            </div>
          ) : streaming.thinking ? (
            <LiveThinking thinking={streaming.thinking} seconds={elapsed} />
          ) : null)}

        {recovering && (
          <div className="my-2 flex items-center gap-2 rounded-lg border border-yellow-700/50 bg-yellow-900/20 px-3 py-2 text-xs text-yellow-200">
            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            {recovering.reason === 'overflow' ? 'Context too large — compacting and retrying…' : "Can't reach the model — reconnecting…"}
            <span className="opacity-60">attempt {recovering.attempt}</span>
          </div>
        )}

        {/* Persistent "still working" indicator — THE dead-air contract: while `busy` (i.e. until the
            final turnDone, the ONLY completion signal), something visible must always say we're working.
            Before a step's first token the model is INGESTING the prompt (a local model re-reads the
            whole conversation — 10-30s of true silence); the ticking per-step seconds prove it's alive.
            Rendered as a real card (not a whisper) so it can't be missed or mistaken for "finished". */}
        {busy && !streaming && !recovering && !toolRunning && (
          // A naked row (matches the flattened tool rows). Suppressed while a tool runs — the
          // tool card carries the activity then (so the row never shows a message that fights the card).
          <div className="my-1.5 flex items-center gap-2 py-1 text-[13px] text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
            <span>{workingMessage}</span>
            <span className="ml-auto tabular-nums text-xs text-muted-foreground/60">{elapsed}s</span>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <ContextMeter />

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
            <ModelPicker />
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
