// ChatsPage.tsx — stub. Multi-chat history per project is a later milestone; for now each project has one
// session, so we point users at their projects.

import { MessagesSquare } from 'lucide-react'
import { useStore } from '@/lib/store'
import { Button } from '@/components/ui/button'

export function ChatsPage() {
  const navigate = useStore((s) => s.navigate)
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-muted-foreground">
      <MessagesSquare className="h-8 w-8 opacity-50" />
      <p className="text-sm">Chat history is coming soon. Each project has its own conversation for now.</p>
      <Button variant="secondary" onClick={() => navigate('projects')}>
        Go to projects
      </Button>
    </div>
  )
}
