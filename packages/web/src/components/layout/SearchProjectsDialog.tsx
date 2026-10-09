// SearchProjectsDialog.tsx — "Search projects", opened from the sidebar's Search item. The usual chat-app
// pattern: search is a destination in the nav, not a permanent input box squatting in the rail. One field,
// every project newest-first, type to narrow, Enter or click to open.
//
// Distinct from the ⌘K CommandPalette on purpose: that one mixes projects with commands; this one is only
// projects, so an empty query is a useful "all my projects, most recent first" list rather than a menu.

import { useState } from 'react'
import { Folder } from 'lucide-react'
import { useStore } from '@/lib/store'
import { relativeTime } from '@/lib/utils'
import { matchesProjectQuery } from '@/lib/projectSearch'
import { useIncrementalList } from '@/lib/incrementalList'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'

export function SearchProjectsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { projects, activeId, openProjectPage } = useStore()
  const [query, setQuery] = useState('')

  const filtered = projects.filter((p) => matchesProjectQuery(p.name, query))
  // Same page-at-a-time rendering as the rail. No rootRef: cmdk's List does not expose a ref on React 18, so
  // the sentinel is judged against the viewport — still clipped by the list, so it fires when it scrolls into
  // view, just without the look-ahead margin.
  const { count, hasMore, sentinelRef } = useIncrementalList({ total: filtered.length, pageSize: 30, resetKey: query })

  const close = (next: boolean) => {
    if (!next) setQuery('') // every open starts from a clean field
    onOpenChange(next)
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent showCloseButton={false} className="top-[20%] translate-y-0 overflow-hidden p-0 sm:max-w-xl">
        <DialogHeader className="sr-only">
          <DialogTitle>Search projects</DialogTitle>
          <DialogDescription>Type to filter your projects, then press Enter to open one.</DialogDescription>
        </DialogHeader>
        {/* shouldFilter={false}: cmdk's built-in fuzzy scorer is order-sensitive, so "supply northline" would
            miss "Build 'Northline Supply', …". Filtering here with the shared matcher keeps this box, the
            Projects page and the rail in agreement. */}
        <Command shouldFilter={false} className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-muted-foreground">
          <CommandInput value={query} onValueChange={setQuery} placeholder="Search projects…" className="h-12" />
          <CommandList className="max-h-[min(420px,60vh)]">
            <CommandEmpty>{projects.length === 0 ? 'No projects yet.' : 'No projects match.'}</CommandEmpty>
            {filtered.length > 0 && (
              <CommandGroup heading={query.trim() ? `${filtered.length} ${filtered.length === 1 ? 'match' : 'matches'}` : 'Recent'}>
                {filtered.slice(0, count).map((p) => (
                  <CommandItem
                    key={p.id}
                    value={p.id}
                    onSelect={() => {
                      close(false)
                      openProjectPage(p.id)
                    }}
                    className="gap-3 py-2.5"
                  >
                    <Folder className="text-muted-foreground" strokeWidth={1.75} />
                    <span className="min-w-0 flex-1 truncate" title={p.name}>{p.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{p.id === activeId ? 'Open' : relativeTime(p.createdAt)}</span>
                  </CommandItem>
                ))}
                {hasMore && <div ref={sentinelRef} aria-hidden="true" className="h-px" />}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
        {/* WCAG 4.1.3: cmdk announces the newly active option, never the count — and on zero results nothing
            at all ('No projects match.' sits in a role=presentation div). An always-mounted polite status region
            is what screen readers actually announce. Empty when there is no query. */}
        <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
          {query.trim() ? (filtered.length === 0 ? 'No projects match' : `${filtered.length} ${filtered.length === 1 ? 'project' : 'projects'} found`) : ''}
        </div>
      </DialogContent>
    </Dialog>
  )
}
