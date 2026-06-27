// PreviewPane.tsx — the Preview tab (M3). Runs the project's dev server in its Docker sandbox and shows it
// in an iframe. States: not-started (Run button) → installing/starting (spinner) → running (iframe) → error.

import { useState, type ReactNode } from 'react'
import { AlertTriangle, Loader2, Play, RotateCw, Square } from 'lucide-react'
import { useStore } from '@/lib/store'
import { Button } from '@/components/ui/button'

function Center({ children }: { children: ReactNode }) {
  return <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">{children}</div>
}

export function PreviewPane() {
  const { activeId, preview, startPreview, stopPreview } = useStore()
  const [reloadKey, setReloadKey] = useState(0)

  if (!activeId) return <Center>Open a project to start.</Center>

  if (preview?.status === 'running' && preview.url) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2">
          <Button variant="ghost" size="icon-sm" title="Reload" onClick={() => setReloadKey((k) => k + 1)}>
            <RotateCw className="h-3.5 w-3.5" />
          </Button>
          <span className="truncate font-mono text-xs text-muted-foreground">{preview.url}</span>
          <Button variant="ghost" size="icon-sm" className="ml-auto" title="Stop" onClick={stopPreview}>
            <Square className="h-3.5 w-3.5" />
          </Button>
        </div>
        <iframe key={reloadKey} src={preview.url} title="Preview" className="min-h-0 flex-1 border-0 bg-white" />
      </div>
    )
  }

  if (preview?.status === 'error') {
    return (
      <Center>
        <div className="text-center">
          <AlertTriangle className="mx-auto h-7 w-7 text-yellow-500" />
          <p className="mt-2 text-sm">Couldn't start the preview.</p>
          <Button className="mt-3" variant="secondary" onClick={startPreview}>
            <Play className="h-4 w-4" /> Retry
          </Button>
        </div>
      </Center>
    )
  }

  if (preview?.status === 'installing' || preview?.status === 'starting') {
    return (
      <Center>
        <div className="text-center">
          <Loader2 className="mx-auto h-6 w-6 animate-spin" />
          <p className="mt-2 text-sm">{preview.status === 'installing' ? 'Installing dependencies…' : 'Starting dev server…'}</p>
          <p className="mt-1 text-xs opacity-70">the first run can take a minute</p>
        </div>
      </Center>
    )
  }

  // not started (null / stopped)
  return (
    <Center>
      <div className="text-center">
        <p className="mb-3">Run the project to see it live.</p>
        <Button onClick={startPreview}>
          <Play className="h-4 w-4" /> Run
        </Button>
      </div>
    </Center>
  )
}
