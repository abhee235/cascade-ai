import { useEffect, useRef, useState } from 'react'
import { Streamdown } from 'streamdown'
import { ArrowUp, ChevronRight, FileText, Loader2, Paperclip, RefreshCw, Square, X } from 'lucide-react'
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

export function ChatPanel() {
  const { items, streaming, status, recovering, busy, stepStartedAt, sawTokens, lastTokenAt, thinkStartedAt, connected, activeId, submit, stop, composerDraft, setComposerDraft } = useStore()
  useTick(busy) // re-render ~1×/s while a turn runs so the elapsed timer ticks even with no tokens
  const elapsed = stepStartedAt ? Math.max(0, Math.floor((Date.now() - stepStartedAt) / 1000)) : 0
  // The live thinking timer counts from the FIRST THINKING TOKEN, not from step start — step start includes
  // prefill, which billed "Reading the conversation…" time as thinking ("Thinking… 18s" on 8s of thought,
  // silently corrected when the committed card appeared). Frozen at the last token once the burst goes quiet.
  const thinkElapsed = thinkStartedAt ? Math.max(0, Math.floor(((lastTokenAt && Date.now() - lastTokenAt > 2500 ? lastTokenAt : Date.now()) - thinkStartedAt) / 1000)) : 0
  // Thinking went QUIET: no delta for a while but the step is still running ⇒ the model is silently generating
  // tool-call arguments (that phase streams NOTHING — a 118-line Write is ~20s of dead air). Labelling it
  // "Thinking…" made healthy turns look stuck (measured: users hit Stop on a working build). useTick's 1s
  // re-render keeps this fresh without extra state churn.
  const thinkingQuiet = busy && sawTokens && lastTokenAt !== null && Date.now() - lastTokenAt > 2500
  // (The early thought-commit itself lives in the STORE as a quiet-debounced timer on the event clock —
  // a render-clock useEffect here raced the event stream and could chop a resumed burst mid-stream.)
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
    ? thinkingQuiet
      ? 'Preparing changes…' // post-thinking silent phase: the model is generating tool args (nothing streams)
      : status || 'Working — running the next step…'
    : workedSinceSubmit
      ? 'Reading the conversation so far…'
      : 'Reading your message and the project context…'
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [dragging, setDragging] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // SCROLL PINNING — follow the bottom ONLY while the user is already there. If they scrolled up to read,
  // new activity must not yank the viewport (the reported pain: cards popping in shoved the content they
  // were reading upward). `atBottomRef` is updated on every scroll; ~80px of slack counts as "at bottom".
  const scrollerRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  const trackScroll = () => {
    const el = scrollerRef.current
    if (el) atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }
  useEffect(() => {
    // Discrete card appends: a SMOOTH glide (a sudden full-card jump reads as a pop even when pinned).
    if (atBottomRef.current) endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [items])
  useEffect(() => {
    // Token streams: INSTANT — smooth scrolling chasing per-frame growth is the bottom-jitter we removed.
    if (atBottomRef.current) endRef.current?.scrollIntoView({ behavior: 'auto' })
  }, [streaming, status, recovering])

  // (A layout-shift absorber lived here — it held the collapsing thinking block's height as bottom padding so
  //  the transcript never shrank. REVERTED 2026-07-25: it could not tell a *block collapsing* from the
  //  transcript being REPLACED. On a new submit / chat switch, `items` resets and the content height drops by
  //  the whole previous conversation; the absorber read that as "content vanished" and reserved all of it —
  //  hundreds of px of blank panel, cleared only by a reload (which resets the ref). A cosmetic shift beats a
  //  blank screen. Any retry must key off the thinking block's own height via ResizeObserver, NOT the
  //  scroller's total height, so a transcript swap can never be mistaken for a collapse.)

  // Live reasoning is pinned to its NEWEST line inside the fixed-height slot (same instant-scroll rule as the
  // transcript: smooth would chase per-token growth). Self-contained — this scroller never moves the panel.
  const thinkScrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = thinkScrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [streaming?.thinking])

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
      {/* pb-8: breathing room — the last card / activity slot must never sit flush against the composer. */}
      <div ref={scrollerRef} onScroll={trackScroll} className="chat-transcript flex-1 overflow-y-auto px-4 pt-3 pb-15">
        {renderTranscript(items)}

        {/* LIVE THOUGHT — must render ABOVE the streaming answer, because that is where the COMMITTED
            ThoughtBlock lands (ActivityCard renders thinking above text inside the assistant item). It used to
            live in the activity slot BELOW the text and was hidden once text began, so a thought visibly
            vanished from under the answer and re-appeared above it a moment later — the reported "thought
            loads one step down, inverted" jump. Same position + same row geometry ⇒ it morphs in place into
            "Thought for Ns" instead of moving. Stays mounted while the answer streams (no !streaming.text
            condition) so it can't disappear mid-turn. */}
        {busy && streaming?.thinking && (
          // `cascade-reveal` grows this block 0 → full height instead of claiming it on one frame, so it
          // unfolds top-to-bottom rather than popping (see index.css). Height-agnostic — it reads the inner
          // block's own height, so retuning h-30 needs no CSS change.
          <div className="cascade-reveal">
          {/* This middle div is the grid TRACK child and must stay height-free — the 0fr→1fr track can only
              compress an auto-height box. The fixed-height block below it overflows and is clipped. */}
          <div>
          <div className="my-1.5 flex h-34 flex-col justify-center overflow-hidden">
            <div className="flex shrink-0 items-center gap-1 mb-1 text-[13px] leading-[21px] text-muted-foreground">
              <ChevronRight className="h-3 w-3 rotate-90" />
              <span className={cn(!streaming.text && 'animate-pulse')}>{thinkingQuiet && !streaming.text ? 'Preparing changes…' : 'Thinking…'}</span>
              {thinkElapsed > 0 && <span className="ml-1 tabular-nums text-xs text-muted-foreground/60">{thinkElapsed}s</span>}
            </div>
            <div ref={thinkScrollRef} className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap border-l-2 border-border pl-3 text-[13px] leading-[21px] text-muted-foreground/80">
              {streaming.thinking}
            </div>
          </div>
          </div>
          </div>
        )}

        {/* Streaming ANSWER text is real content — it flows in the transcript like a finished message. */}
        {streaming?.text && (
          <div className="my-3 prose prose-sm dark:prose-invert max-w-none">
            <Streamdown>{streaming.text}</Streamdown>
          </div>
        )}

        {/* ACTIVITY SLOT — the dead-air contract, structurally shift-free. ONE fixed-height container exists
            for the whole turn; every transient indicator (live thinking / retry / working row) swaps INSIDE
            it. Previously each indicator was its own block that appeared/disappeared — the ~120px live
            thinking box popping in and out between qwen's 1-3s think bursts was the bottom-of-panel flicker.
            The full reasoning still lands in the transcript as the collapsible "Thought for Ns" item. */}
        {busy && (
          <div className="my-1.5 flex h-10 flex-col justify-center overflow-hidden">
            {recovering ? (
              <div className="flex items-center gap-2 text-[13px] text-yellow-600 dark:text-yellow-300">
                <RefreshCw className="h-3.5 w-3.5 shrink-0 animate-spin" />
                <span className="truncate">{recovering.reason === 'overflow' ? 'Context too large — compacting and retrying…' : "Can't reach the model — reconnecting…"}</span>
                <span className="shrink-0 opacity-60">attempt {recovering.attempt}</span>
              </div>
              // Streaming content (thinking OR answer) is its own indicator while it MOVES — the row would
              // just duplicate it. Once it goes quiet the model is silently generating tool-call arguments (a
              // 118-line Write is ~20s of NOTHING on the wire); suppressing the row there left a blank panel
              // that reads as frozen, which is when users hit Stop on a healthy build. So quiet falls through
              // to the working row and surfaces "Preparing changes…".
            ) : (streaming?.text || streaming?.thinking) && !thinkingQuiet ? null : !toolRunning ? (
              <div className="flex w-full items-center gap-2 text-[13px] text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
                <span className="truncate">{workingMessage}</span>
                <span className="ml-auto shrink-0 tabular-nums text-xs text-muted-foreground/60">{elapsed}s</span>
              </div>
            ) : null /* tool running: its card above carries the activity — the slot stays as silent ballast */}
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
