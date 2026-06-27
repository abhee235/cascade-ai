import { useEffect, useState } from 'react'
import { Folder, FolderOpen, Plus, X } from 'lucide-react'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

const BLANK = 'blank'

export function Sidebar() {
  const { projects, templates, activeId, createProject, openProject, deleteProject } = useStore()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  // Default to the first real template (so new projects are runnable apps), falling back to a blank dir.
  const [templateId, setTemplateId] = useState<string>(BLANK)
  // Templates arrive over the socket after mount — default to the first one once they load.
  useEffect(() => {
    if (templates.length && templateId === BLANK) setTemplateId(templates[0].id)
  }, [templates, templateId])

  const submit = () => {
    if (name.trim()) {
      createProject(name, templateId === BLANK ? undefined : templateId)
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
        <div className="space-y-2 border-b border-border p-2">
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
          <Select value={templateId} onValueChange={setTemplateId}>
            <SelectTrigger size="sm" className="w-full text-xs">
              <SelectValue placeholder="Template" />
            </SelectTrigger>
            <SelectContent>
              {templates.map((t) => (
                <SelectItem key={t.id} value={t.id} className="text-xs">
                  {t.name} — <span className="text-muted-foreground">{t.description}</span>
                </SelectItem>
              ))}
              <SelectItem value={BLANK} className="text-xs">
                Blank — <span className="text-muted-foreground">empty folder</span>
              </SelectItem>
            </SelectContent>
          </Select>
          <Button size="sm" className="w-full" onClick={submit} disabled={!name.trim()}>
            Create
          </Button>
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
