import {
  SidebarProvider, Sidebar, SidebarHeader, SidebarContent, SidebarGroup,
  SidebarGroupLabel, SidebarGroupContent, SidebarMenu, SidebarMenuItem,
  SidebarMenuButton, SidebarFooter, SidebarInset, SidebarTrigger,
} from '@cascade/web'
import { Folder, Search, Play, Settings } from 'lucide-react'

export const Workspace = () => (
  <SidebarProvider className="min-h-0 h-[460px] rounded-lg border overflow-hidden">
    <Sidebar collapsible="none">
      <SidebarHeader>
        <div className="px-2 py-1.5 text-sm font-semibold">Cascade</div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem><SidebarMenuButton isActive><Folder /> Files</SidebarMenuButton></SidebarMenuItem>
              <SidebarMenuItem><SidebarMenuButton><Search /> Search</SidebarMenuButton></SidebarMenuItem>
              <SidebarMenuItem><SidebarMenuButton><Play /> Run</SidebarMenuButton></SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem><SidebarMenuButton><Settings /> Settings</SidebarMenuButton></SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
    <SidebarInset>
      <header className="flex h-12 items-center gap-2 border-b px-4">
        <SidebarTrigger />
        <span className="text-sm font-medium">Files</span>
      </header>
      <div className="p-4 text-sm text-muted-foreground">Select a file to start editing.</div>
    </SidebarInset>
  </SidebarProvider>
)
