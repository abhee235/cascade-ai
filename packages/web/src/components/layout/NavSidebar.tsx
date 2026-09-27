// NavSidebar.tsx — the persistent left rail, built on the shadcn Sidebar. New · Home · Projects ·
// Chats · Settings, a Recent-projects list, and the user profile + connection + theme toggle at the bottom.

import { Folder, FolderKanban, Home, MessagesSquare, Moon, Plug, Plus, Radar, Settings, Sun, X, type LucideIcon } from 'lucide-react'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'
import type { Page } from '@/lib/types'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarTrigger,
} from '@/components/ui/sidebar'
import { Button } from '@/components/ui/button'

const NAV: { page: Page; label: string; icon: LucideIcon }[] = [
  { page: 'home', label: 'Home', icon: Home },
  { page: 'projects', label: 'Projects', icon: FolderKanban },
  { page: 'chats', label: 'Chats', icon: MessagesSquare },
  { page: 'mcp', label: 'Connectors', icon: Plug },
  { page: 'observatory', label: 'Observatory', icon: Radar },
  { page: 'settings', label: 'Settings', icon: Settings },
]

export function NavSidebar() {
  const { page, navigate, projects, activeId, openProjectPage, deleteProject, connected, theme, toggleTheme, turnActivity } = useStore()

  return (
    // collapsible="icon" (not the default "offcanvas", which slid the whole rail off-screen leaving NOTHING
    // clickable): collapsed keeps an icon rail, so every destination stays one click away without re-opening
    // the sidebar. Labels are hidden by the primitive's group-data-[collapsible=icon] rules; the `tooltip`
    // prop on each button supplies the name on hover, which is the only affordance left once text is gone.
    <Sidebar collapsible="icon">
      <SidebarHeader className="gap-2">
        {/* Brand: the wordmark hides in rail mode, the mark stays as the visual anchor. */}
        <div className="flex items-center gap-2 rounded-md px-2 py-1.5 group-data-[collapsible=icon]:px-0 group-data-[collapsible=icon]:justify-center">
          {/* Brand mark: three descending bars (the cascade), sky→teal — same mark as the site. */}
          <svg viewBox="0 0 32 32" fill="none" aria-hidden="true" className="h-6 w-6 shrink-0">
            <defs>
              <linearGradient id="cascade-mark-grad" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#38bdf8" />
                <stop offset="1" stopColor="#2dd4bf" />
              </linearGradient>
            </defs>
            <rect x="3" y="3" width="7" height="19" rx="3.5" fill="url(#cascade-mark-grad)" />
            <rect x="12.5" y="8" width="7" height="19" rx="3.5" fill="url(#cascade-mark-grad)" opacity="0.75" />
            <rect x="22" y="13" width="7" height="16" rx="3.5" fill="url(#cascade-mark-grad)" opacity="0.5" />
          </svg>
          <span className="font-semibold tracking-tight group-data-[collapsible=icon]:hidden">Cascade</span>
          {/* The ONLY toggle outside ProjectPage: without it, collapsing on Home/Projects/Chats/Connectors/
              Settings left no way back — you had to open a project to find a trigger. Sits inline when
              expanded, drops under the mark in rail mode. */}
          <SidebarTrigger className="ml-auto text-muted-foreground group-data-[collapsible=icon]:hidden" />
        </div>
        <SidebarTrigger className="hidden self-center text-muted-foreground group-data-[collapsible=icon]:flex" />
        {/* Rail mode shrinks this to a square +. Deliberately 28px, not the nav buttons' 32px: this is the
            only SOLID-filled control, and a filled block 8px from both walls reads as colliding with them,
            while the ghost nav buttons only ever paint their 16px icon inside a transparent 32px hit area.
            Equal geometry, unequal optics — so the fill is inset to match how the others LOOK. */}
        <Button
          className="w-full justify-start gap-2 group-data-[collapsible=icon]:mx-auto group-data-[collapsible=icon]:h-7 group-data-[collapsible=icon]:w-7 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0"
          title="New project"
          onClick={() => navigate('home')}
        >
          <Plus className="h-4 w-4 shrink-0 group-data-[collapsible=icon]:h-4.5 group-data-[collapsible=icon]:w-4.5" />
          <span className="group-data-[collapsible=icon]:hidden">New project</span>
        </Button>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV.map((n) => (
                <SidebarMenuItem key={n.page}>
                  <SidebarMenuButton tooltip={n.label} isActive={page === n.page} onClick={() => navigate(n.page)}>
                    <n.icon />
                    <span>{n.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Recent projects</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {/* Distinguish "still connecting" from "truly none" — a slow connect must not read as data loss. */}
              {projects.length === 0 && <div className="px-2 py-1 text-xs text-muted-foreground/60">{connected ? 'No projects yet.' : 'Connecting…'}</div>}
              {projects.slice(0, 12).map((p) => {
                // ADR-068: the single active turn's project gets a dot — amber (needs your approval) or a
                // pulsing blue (building) — so you can return to it from anywhere. Sits left of the ×.
                const act = turnActivity?.projectId === p.id ? turnActivity.phase : undefined
                return (
                  <SidebarMenuItem key={p.id}>
                    <SidebarMenuButton tooltip={p.name} isActive={page === 'project' && activeId === p.id} onClick={() => openProjectPage(p.id)}>
                      <Folder strokeWidth={1.75} />
                      {/* ADR-084 Phase 5: the rail is narrow and prompt-derived names collide — two
                          projects both truncate to "Build 'Northline Supply', a …". Until the names
                          themselves carry a differentiator, the full name must at least be recoverable. */}
                      <span className="truncate" title={p.name}>{p.name}</span>
                      {act && (
                        <span
                          className={cn('ml-auto mr-1 h-2 w-2 shrink-0 rounded-full', act === 'awaiting' ? 'bg-amber-500' : 'animate-pulse bg-blue-500')}
                          title={act === 'awaiting' ? 'Waiting for your approval' : 'Building…'}
                        />
                      )}
                    </SidebarMenuButton>
                    <SidebarMenuAction showOnHover title="Delete project" onClick={() => deleteProject(p.id)}>
                      <X />
                    </SidebarMenuAction>
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        {/* Rail mode: this row would overflow a ~3rem rail, so it stacks — avatar (carrying the connection
            dot as a corner badge) above the theme toggle. Nothing is lost, just re-laid-out. */}
        <div className="flex items-center gap-2 px-1 group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:gap-1 group-data-[collapsible=icon]:px-0">
          <div className="relative shrink-0">
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-sidebar-accent text-xs font-semibold">L</div>
            {/* Expanded shows the dot inline (below); collapsed pins it to the avatar so status survives. */}
            <span
              className={cn(
                'absolute -right-0.5 -bottom-0.5 hidden h-2 w-2 rounded-full ring-2 ring-sidebar group-data-[collapsible=icon]:block',
                connected ? 'bg-green-500' : 'bg-muted-foreground/40',
              )}
            />
          </div>
          <span className="truncate text-sm group-data-[collapsible=icon]:hidden">local</span>
          <span
            className={cn('ml-auto h-2 w-2 shrink-0 rounded-full group-data-[collapsible=icon]:hidden', connected ? 'bg-green-500' : 'bg-muted-foreground/40')}
            title={connected ? 'connected' : 'connecting…'}
          />
          <Button variant="ghost" size="icon-sm" onClick={toggleTheme} title={connected ? 'Toggle theme (connected)' : 'Toggle theme (connecting…)'}>
            {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
