// ChatHeader.tsx — multi-chat switcher (M11): the active chat's title with a dropdown to switch/delete, plus a
// "New chat" button. Chats are server-persisted per project; this just drives the store actions.

import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, MessageSquarePlus, Trash2 } from 'lucide-react'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'

export function ChatHeader() {
  const { chats, activeChatId, newChat, switchChat, deleteChat, activeId } = useStore()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!activeId || chats.length === 0) return null
  const active = chats.find((c) => c.id === activeChatId)

  return (
    <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-2">
      <div className="relative min-w-0" ref={ref}>
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="flex max-w-[260px] items-center gap-1 rounded-md px-2 py-1 text-[13px] font-medium text-foreground hover:bg-accent"
        >
          <span className="truncate">{active?.title ?? 'Chat'}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </button>
        {open && (
          <div role="menu" className="absolute left-0 top-full z-30 mt-1 max-h-80 w-72 overflow-auto rounded-md border border-border bg-popover p-1 shadow-lg">
            <div className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Chats</div>
            {chats.map((c) => (
              <div
                key={c.id}
                className={cn(
                  'group flex items-center rounded text-xs',
                  c.id === activeChatId ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50',
                )}
              >
                {/* Real buttons (not clickable divs) so switching and deleting are keyboard-reachable. */}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    switchChat(c.id)
                    setOpen(false)
                  }}
                  className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
                >
                  {c.id === activeChatId ? <Check className="h-3.5 w-3.5 shrink-0" /> : <span className="w-3.5 shrink-0" />}
                  <span className="min-w-0 flex-1 truncate">{c.title}</span>
                </button>
                <button
                  type="button"
                  title="Delete chat"
                  onClick={() => deleteChat(c.id)}
                  className="px-2 py-1.5 opacity-0 transition-opacity hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      <button
        type="button"
        title="New chat"
        onClick={newChat}
        className="ml-auto flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <MessageSquarePlus className="h-4 w-4" />
      </button>
    </div>
  )
}
