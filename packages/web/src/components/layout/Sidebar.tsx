import { useState } from 'react'
import { Folder, FolderOpen, Plus, X } from 'lucide-react'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function Sidebar() {
  const { projects, activeId, createProject, openProject, deleteProject } = useStore()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')

  const submit = () => {
    if (name.trim()) {
      createProject(name)
      setName('')
      setCreating(false)
    }
  }

  return (
    <aside className="flex h-full flex-col bg-background">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Projects</span>
        <Button variant="ghost" size="icon-sm" className="ml-auto" title="New project" onClick={() => setCreating((c) => !c)}>
          <Plus />
        </Button>
      </div>

      {creating && (
        <div className="border-b border-border p-2">
          <Input
            autoFocus
            className="h-8 text-xs"
            placeholder="project name…"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
              if (e.key === 'Escape') (setCreating(false), setName(''))
            }}
          />
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-1">
        {projects.length === 0 && <div className="px-2 py-3 text-xs text-muted-foreground/70">No projects yet.</div>}
        {projects.map((p) => {
          const active = p.id === activeId
          return (
            <div
              key={p.id}
              className={cn(
                'group flex cursor-pointer items-center gap-1.5 rounded px-2 py-1.5 text-sm',
                active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50',
              )}
              onClick={() => openProject(p.id)}
            >
              {active ? <FolderOpen className="h-4 w-4 shrink-0" /> : <Folder className="h-4 w-4 shrink-0" />}
              <span className="truncate">{p.name}</span>
              <button
                className="ml-auto hidden text-muted-foreground hover:text-red-400 group-hover:block"
                title="Delete project"
                onClick={(e) => {
                  e.stopPropagation()
                  deleteProject(p.id)
                }}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )
        })}
      </div>
    </aside>
  )
}
