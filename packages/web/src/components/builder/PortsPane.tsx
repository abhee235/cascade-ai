// PortsPane.tsx — the PORTS tab of the bottom panel (M7): shows the running preview's forwarded port + the
// stable proxy URL (from the M5.2 preview proxy). VS Code shows forwarded ports here too.

import { Globe } from 'lucide-react'
import { useStore } from '@/lib/store'

export function PortsPane() {
  const { preview } = useStore()
  const running = preview?.status === 'running' && preview.url

  if (!running) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-xs text-muted-foreground">
        No forwarded ports. Run the preview to expose the dev server.
      </div>
    )
  }

  return (
    <div className="p-3 text-xs">
      <div className="flex items-center gap-2">
        <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="font-medium">5173</span>
        <span className="text-muted-foreground">dev server</span>
        <a href={preview.url} target="_blank" rel="noreferrer" className="ml-auto truncate font-mono text-primary hover:underline">
          {preview.url}
        </a>
      </div>
    </div>
  )
}
