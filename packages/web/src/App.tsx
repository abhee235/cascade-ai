import { useEffect } from 'react'
import { WsClient } from './lib/wsClient'
import { useStore } from './lib/store'
import { AppLayout } from './components/layout/AppLayout'
import { TooltipProvider } from '@/components/ui/tooltip'

const WS_URL = `ws://${location.hostname}:4319`

export function App() {
  useEffect(() => {
    const { handleEvent, setConnected, setSend, initRouter, reopenActive } = useStore.getState()
    // On every (re)connect, re-assert the active project so the new server connection knows which project
    // this client is on (a fresh connection starts with no active project).
    const client = new WsClient(WS_URL, handleEvent, (connected) => {
      setConnected(connected)
      if (connected) reopenActive()
    })
    setSend((m) => client.send(m))
    client.connect()
    initRouter() // sync the address bar ↔ in-store router (deep-link /project/<slug>, back/forward)
    return () => client.close() // StrictMode/HMR: tear down so we don't leak reconnecting sockets
  }, [])

  return (
    <TooltipProvider delayDuration={300}>
      <AppLayout />
    </TooltipProvider>
  )
}
