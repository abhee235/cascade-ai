import { useEffect } from 'react'
import { WsClient } from './lib/wsClient'
import { useStore } from './lib/store'
import { AppLayout } from './components/layout/AppLayout'
import { TooltipProvider } from '@/components/ui/tooltip'

const WS_URL = `ws://${location.hostname}:4319`

export function App() {
  useEffect(() => {
    const { handleEvent, setConnected, setSend, initRouter } = useStore.getState()
    const client = new WsClient(WS_URL, handleEvent, setConnected)
    setSend((m) => client.send(m))
    client.connect()
    initRouter() // sync the address bar ↔ in-store router (deep-link /project/<slug>, back/forward)
  }, [])

  return (
    <TooltipProvider delayDuration={300}>
      <AppLayout />
    </TooltipProvider>
  )
}
