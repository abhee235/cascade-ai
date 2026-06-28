// AppLayout.tsx — the shell: the persistent NavSidebar + the active page (lightweight in-store router).

import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { useStore } from '@/lib/store'
import { CommandPalette } from '@/components/CommandPalette'
import { NavSidebar } from './NavSidebar'
import { HomePage } from '@/pages/HomePage'
import { ProjectPage } from '@/pages/ProjectPage'
import { ProjectsPage } from '@/pages/ProjectsPage'
import { ChatsPage } from '@/pages/ChatsPage'
import { SettingsPage } from '@/pages/SettingsPage'

export function AppLayout() {
  const page = useStore((s) => s.page)
  return (
    // h-svh (not the provider's default min-h-svh) makes the shell a fixed viewport box, so the chat panel
    // and the builder pane each scroll internally instead of growing the whole page.
    <SidebarProvider className="h-svh overflow-hidden">
      <CommandPalette />
      <NavSidebar />
      <SidebarInset className="min-h-0 overflow-hidden">
        {page === 'home' ? (
          <HomePage />
        ) : page === 'project' ? (
          <ProjectPage />
        ) : page === 'projects' ? (
          <ProjectsPage />
        ) : page === 'chats' ? (
          <ChatsPage />
        ) : (
          <SettingsPage />
        )}
      </SidebarInset>
    </SidebarProvider>
  )
}
