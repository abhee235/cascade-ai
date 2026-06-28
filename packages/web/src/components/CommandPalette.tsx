// CommandPalette.tsx — ⌘K / Ctrl+K quick switcher (M11): jump to a project, navigate, or run a project
// action (preview, tabs, terminal, theme). Mounted once in AppLayout; toggled by the global shortcut.

import { useEffect, useState } from 'react'
import { Code2, FolderOpen, Home, LayoutGrid, MessageSquare, Moon, Palette, PlusCircle, Settings, SquareTerminal, Play, Square, Eye, History } from 'lucide-react'
import { useStore } from '@/lib/store'
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from '@/components/ui/command'

export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const { projects, activeId, page, openProjectPage, navigate, toggleTheme, startPreview, stopPreview, setRightTab, setBottomTab, toggleBottom, newTerminal, setCustomizeOpen } = useStore()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const run = (fn: () => void) => {
    setOpen(false)
    fn()
  }
  const openTerminal = () => {
    setBottomTab('terminal')
    if (!useStore.getState().bottomOpen) toggleBottom()
  }
  const inProject = page === 'project' && !!activeId

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Search projects or run a command…" />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

        {projects.length > 0 && (
          <CommandGroup heading="Projects">
            {projects.map((p) => (
              <CommandItem key={p.id} value={`project ${p.name}`} onSelect={() => run(() => openProjectPage(p.id))}>
                <FolderOpen /> {p.name}
                {p.id === activeId && <CommandShortcut>active</CommandShortcut>}
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {inProject && (
          <CommandGroup heading="Current project">
            <CommandItem value="run preview start dev" onSelect={() => run(() => { setRightTab('preview'); startPreview() })}>
              <Play /> Run preview
            </CommandItem>
            <CommandItem value="stop preview" onSelect={() => run(stopPreview)}>
              <Square /> Stop preview
            </CommandItem>
            <CommandItem value="open preview tab" onSelect={() => run(() => setRightTab('preview'))}>
              <Eye /> Preview
            </CommandItem>
            <CommandItem value="open code tab editor" onSelect={() => run(() => setRightTab('code'))}>
              <Code2 /> Code
            </CommandItem>
            <CommandItem value="open versions checkpoints" onSelect={() => run(() => setRightTab('versions'))}>
              <History /> Versions
            </CommandItem>
            <CommandItem value="open terminal" onSelect={() => run(openTerminal)}>
              <SquareTerminal /> Open terminal
            </CommandItem>
            <CommandItem value="new terminal session" onSelect={() => run(() => { openTerminal(); newTerminal() })}>
              <SquareTerminal /> New terminal session
            </CommandItem>
          </CommandGroup>
        )}

        <CommandGroup heading="Go to">
          <CommandItem value="home" onSelect={() => run(() => navigate('home'))}>
            <Home /> Home
          </CommandItem>
          <CommandItem value="projects list" onSelect={() => run(() => navigate('projects'))}>
            <LayoutGrid /> Projects
          </CommandItem>
          <CommandItem value="chats" onSelect={() => run(() => navigate('chats'))}>
            <MessageSquare /> Chats
          </CommandItem>
          <CommandItem value="settings" onSelect={() => run(() => navigate('settings'))}>
            <Settings /> Settings
          </CommandItem>
        </CommandGroup>

        <CommandGroup heading="Actions">
          <CommandItem value="new project create" onSelect={() => run(() => navigate('home'))}>
            <PlusCircle /> New project
          </CommandItem>
          <CommandItem value="toggle theme dark light" onSelect={() => run(toggleTheme)}>
            <Moon /> Toggle theme
          </CommandItem>
          <CommandItem value="customize theme accent color" onSelect={() => run(() => setCustomizeOpen(true))}>
            <Palette /> Customize theme…
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
