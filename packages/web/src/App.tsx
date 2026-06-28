import { useEffect } from 'react'
import { WsClient } from './lib/wsClient'
import { useStore } from './lib/store'
import { AppLayout } from './components/layout/AppLayout'
import { TooltipProvider } from '@/components/ui/tooltip'

const SERVER = `${location.hostname}:4319`

// Fetch the per-run auth token (CORS-guarded to our origin) and build the tokenized WS URL. Re-run before each
// (re)connect so a server restart's new token is picked up (M7 security). A cross-site page can't read /token.
async function resolveWsUrl(): Promise<string> {
  let token = ''
  try {
    token = (await (await fetch(`http://${SERVER}/token`)).json()).token ?? ''
  } catch {
    /* server not up yet — connect without a token (a no-origin client is allowed; a browser will be rejected) */
  }
  return `ws://${SERVER}/?token=${encodeURIComponent(token)}`
}

export function App() {
  useEffect(() => {
    const { handleEvent, setConnected, setSend, initRouter, reopenActive } = useStore.getState()
    // On every (re)connect, re-assert the active project so the new server connection knows which project
    // this client is on (a fresh connection starts with no active project).
    const client = new WsClient(resolveWsUrl, handleEvent, (connected) => {
      setConnected(connected)
      if (connected) reopenActive()
    })
    setSend((m) => client.send(m))
    client.connect()
    initRouter() // sync the address bar ↔ in-store router (deep-link /project/<slug>, back/forward)

    // Build/runtime errors from the preview iframe (the proxy injects a capture script that postMessages here).
    const onMsg = (e: MessageEvent) => {
      if (!e.data || typeof e.data !== 'object') return
      if (e.data.__cascade === 'preview-error') useStore.getState().onPreviewError(e.data.payload)
      else if (e.data.__cascade === 'preview-edit') useStore.getState().editPreviewText(e.data.loc, e.data.tag, e.data.text) // M9: committed in-place edit
      else if (e.data.__cascade === 'preview-ai') useStore.getState().aiEditPreview(e.data.loc, e.data.tag, e.data.text) // M9: ✦ AI button
    }
    window.addEventListener('message', onMsg)

    return () => {
      window.removeEventListener('message', onMsg)
      client.close() // StrictMode/HMR: tear down so we don't leak reconnecting sockets
    }
  }, [])

  return (
    <TooltipProvider delayDuration={300}>
      <AppLayout />
    </TooltipProvider>
  )
}
