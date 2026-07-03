// ChatsPage.tsx — every project's chat history in one place. The server aggregates each project's
// .cascade/chats.json (read-only peek — listing never creates or prunes); clicking a chat opens its project
// AND switches the session to that conversation.

import { useEffect } from 'react'
import { Folder, MessagesSquare } from 'lucide-react'
import { useStore } from '@/lib/store'
import { Button } from '@/components/ui/button'

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export function ChatsPage() {
  const { allChats, connected, requestAllChats, openChat, navigate } = useStore()

  // (Re)load on mount and whenever the connection (re)establishes — the list lives server-side.
  useEffect(() => {
    if (connected) requestAllChats()
  }, [connected, requestAllChats])

  if (allChats.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-muted-foreground">
        <MessagesSquare className="h-8 w-8 opacity-50" />
        <p className="text-sm">{connected ? 'No chats yet — open a project and start one.' : 'Connecting…'}</p>
        {connected && (
          <Button variant="secondary" onClick={() => navigate('projects')}>
            Go to projects
          </Button>
        )}
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <h1 className="text-2xl font-semibold">Chats</h1>
        <div className="mt-6 space-y-6">
          {allChats.map(({ project, chats }) => (
            <section key={project.id}>
              <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <Folder className="h-3.5 w-3.5" /> {project.name}
              </div>
              <div className="mt-2 overflow-hidden rounded-lg border border-border">
                {chats.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => openChat(project.id, c.id)}
                    className="flex w-full items-center gap-3 border-b border-border px-3 py-2.5 text-left text-sm transition-colors last:border-b-0 hover:bg-accent"
                  >
                    <MessagesSquare className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{c.title}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{ago(c.updatedAt)}</span>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
