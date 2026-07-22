// PreviewPane.tsx — the Preview tab (M3). Runs the project's dev server in its Docker sandbox and shows it
// in an iframe. States: not-started (Run button) → installing/starting (spinner) → running (iframe) → error.
// Visual editing (M9): a "Select" toggle arms pick-mode in the iframe (via postMessage to the proxy-injected
// overlay script); a click there reports the element back and we float an inspector to edit it.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, Loader2, MousePointerSquareDashed, Play, RotateCw, Square } from 'lucide-react'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { DEVICE_WIDTH } from './DeviceSwitcher'

function Center({ children }: { children: ReactNode }) {
  return <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">{children}</div>
}

export function PreviewPane() {
  const { activeId, preview, startPreview, stopPreview, selectMode, toggleSelectMode, busy, previewDevice: device } = useStore()
  const [reloadKey, setReloadKey] = useState(0)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  // Drive the proxy-injected overlay's pick-mode. Re-assert on every (re)load — the injected script restarts
  // fresh after HMR, so it would otherwise lose the armed state.
  const postMode = () => iframeRef.current?.contentWindow?.postMessage({ __cascade: 'select-mode', on: selectMode }, '*')
  // biome-ignore lint/correctness/useExhaustiveDependencies: also re-post when the iframe reloads
  useEffect(postMode, [selectMode, reloadKey])

  if (!activeId) return <Center>Open a project to start.</Center>

  if (preview?.status === 'running' && preview.url) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2">
          <Button variant="ghost" size="icon-sm" title="Reload" onClick={() => setReloadKey((k) => k + 1)}>
            <RotateCw className="h-3.5 w-3.5" />
          </Button>
          <span className="truncate font-mono text-xs text-muted-foreground">{preview.url}</span>
          <Button
            variant={selectMode ? 'default' : 'ghost'}
            size="icon-sm"
            className="ml-auto"
            title={selectMode ? 'Cancel select' : 'Select an element to edit'}
            onClick={toggleSelectMode}
          >
            <MousePointerSquareDashed className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="icon-sm" title="Stop" onClick={stopPreview}>
            <Square className="h-3.5 w-3.5" />
          </Button>
        </div>
        <div className={cn('relative min-h-0 flex-1', device !== 'desktop' && 'flex justify-center overflow-auto bg-muted/40 p-4')}>
          <iframe
            ref={iframeRef}
            key={reloadKey}
            src={preview.url}
            title="Preview"
            onLoad={postMode}
            // Desktop fills the pane; tablet/mobile clamp to a real device width and get a device-ish frame.
            style={device === 'desktop' ? undefined : { width: DEVICE_WIDTH[device], maxWidth: '100%' }}
            className={cn('border-0 bg-white', device === 'desktop' ? 'h-full w-full' : 'h-full shrink-0 rounded-xl border border-border shadow-lg')}
          />
          {/* Building banner (walkthrough feedback): while the agent works, what's rendering may still be
              the starter showcase — label it so it's never mistaken for the user's finished app. The
              preview stays LIVE (Vite HMR swaps in the real app file-by-file as the agent writes it). */}
          {busy && (
            <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center">
              <span className="mt-2 flex items-center gap-2 rounded-full border bg-background/90 px-3.5 py-1.5 text-xs font-medium shadow backdrop-blur">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                Cascade is building your app — this preview updates live as code lands
              </span>
            </div>
          )}
          {selectMode && (
            <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center">
              <span className="mt-2 rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground shadow">
                Click any text to edit it in place
              </span>
            </div>
          )}
        </div>
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

