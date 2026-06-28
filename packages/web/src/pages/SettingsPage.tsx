// SettingsPage.tsx — stub. Model/provider, tools/MCP, and behavior settings land in a later milestone (M8).

import { Settings } from 'lucide-react'

export function SettingsPage() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-muted-foreground">
      <Settings className="h-8 w-8 opacity-50" />
      <p className="text-sm">Settings (model / provider, tools &amp; MCP, theme) are coming soon.</p>
    </div>
  )
}
