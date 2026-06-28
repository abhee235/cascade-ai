// NavSidebar.tsx — the persistent left rail, built on the shadcn Sidebar. New · Home · Projects ·
// Chats · Settings, a Recent-projects list, and the user profile + connection + theme toggle at the bottom.

import { Folder, FolderKanban, Home, MessagesSquare, Moon, Plus, Settings, Sparkles, Sun, X, type LucideIcon } from 'lucide-react'
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
} from '@/components/ui/sidebar'
import { Button } from '@/components/ui/button'

const NAV: { page: Page; label: string; icon: LucideIcon }[] = [
  { page: 'home', label: 'Home', icon: Home },
  { page: 'projects', label: 'Projects', icon: FolderKanban },
  { page: 'chats', label: 'Chats', icon: MessagesSquare },
  { page: 'settings', label: 'Settings', icon: Settings },
]

export function NavSidebar() {
  const { page, navigate, projects, activeId, openProjectPage, deleteProject, connected, theme, toggleTheme } = useStore()

  return (
    <Sidebar>
      <SidebarHeader className="gap-2">
        <div className="flex items-center gap-2 rounded-md px-2 py-1.5">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Sparkles className="h-3.5 w-3.5" />
          </div>
          <span className="font-semibold tracking-tight">Cascade</span>
        </div>
        <Button className="w-full justify-start gap-2" onClick={() => navigate('home')}>
          <Plus className="h-4 w-4" /> New project
        </Button>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV.map((n) => (
                <SidebarMenuItem key={n.page}>
                  <SidebarMenuButton isActive={page === n.page} onClick={() => navigate(n.page)}>
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
              {projects.length === 0 && <div className="px-2 py-1 text-xs text-muted-foreground/60">No projects yet.</div>}
              {projects.slice(0, 12).map((p) => (
                <SidebarMenuItem key={p.id}>
                  <SidebarMenuButton isActive={page === 'project' && activeId === p.id} onClick={() => openProjectPage(p.id)}>
                    <Folder />
                    <span className="truncate">{p.name}</span>
                  </SidebarMenuButton>
                  <SidebarMenuAction showOnHover title="Delete project" onClick={() => deleteProject(p.id)}>
                    <X />
                  </SidebarMenuAction>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <div className="flex items-center gap-2 px-1">
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-sidebar-accent text-xs font-semibold">L</div>
          <span className="truncate text-sm">local</span>
          <span
            className={cn('ml-auto h-2 w-2 shrink-0 rounded-full', connected ? 'bg-green-500' : 'bg-muted-foreground/40')}
            title={connected ? 'connected' : 'connecting…'}
          />
          <Button variant="ghost" size="icon-sm" onClick={toggleTheme} title="Toggle theme">
            {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>
        </div>
      </SidebarFooter>
    </Sidebar>
  )
}
