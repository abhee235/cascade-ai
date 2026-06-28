// ProjectsPage.tsx — a project gallery: 16:9 preview cards (gradient placeholder for now), with an
// avatar + name + relative time + overflow menu, plus a search + "New project" header.

import { useState } from 'react'
import { AppWindow, MoreHorizontal, Plus, Search, Trash2, SquareArrowOutUpRight } from 'lucide-react'
import { useStore } from '@/lib/store'
import { relativeTime } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'

export function ProjectsPage() {
  const { projects, openProjectPage, deleteProject, navigate } = useStore()
  const [query, setQuery] = useState('')
  const shown = projects.filter((p) => p.name.toLowerCase().includes(query.toLowerCase()))

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-8 py-8">
        <h1 className="text-2xl font-bold tracking-tight">Projects</h1>

        <div className="mt-5 flex items-center gap-3">
          <div className="relative max-w-md flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search projects…" className="pl-9" />
          </div>
          <Button className="ml-auto gap-1.5" onClick={() => navigate('home')}>
            <Plus className="h-4 w-4" /> New project
          </Button>
        </div>

        {shown.length === 0 ? (
          <div className="mt-16 text-center text-sm text-muted-foreground/70">
            {projects.length === 0 ? 'No projects yet — create one to get started.' : 'No projects match your search.'}
          </div>
        ) : (
          <div className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {shown.map((p) => {
              const initial = (p.name.trim()[0] ?? '?').toUpperCase()
              return (
                <div key={p.id} className="group cursor-pointer" onClick={() => openProjectPage(p.id)}>
                  <div className="flex aspect-video w-full items-center justify-center overflow-hidden rounded-xl border border-border bg-muted/50 ring-offset-background transition-all group-hover:ring-2 group-hover:ring-ring/40">
                    <AppWindow className="h-9 w-9 text-muted-foreground/25" strokeWidth={1.5} />
                  </div>
                  <div className="mt-2.5 flex items-center gap-2.5 px-0.5">
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-semibold text-muted-foreground">
                      {initial}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium leading-tight">{p.name}</div>
                      <div className="text-xs text-muted-foreground">{relativeTime(p.createdAt)}</div>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        onClick={(e) => e.stopPropagation()}
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:bg-accent data-[state=open]:opacity-100"
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                        <DropdownMenuItem onClick={() => openProjectPage(p.id)}>
                          <SquareArrowOutUpRight className="h-4 w-4" /> Open
                        </DropdownMenuItem>
                        <DropdownMenuItem variant="destructive" onClick={() => deleteProject(p.id)}>
                          <Trash2 className="h-4 w-4" /> Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
