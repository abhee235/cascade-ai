import { useEffect } from 'react'
import { WsClient } from './lib/wsClient'
import { useStore } from './lib/store'
import { AppShell } from './components/layout/AppShell'
import { TooltipProvider } from '@/components/ui/tooltip'

const WS_URL = `ws://${location.hostname}:4319`

export function App() {
  useEffect(() => {
    const { handleEvent, setConnected, setSend } = useStore.getState()
    const client = new WsClient(WS_URL, handleEvent, setConnected)
    setSend((m) => client.send(m))
    client.connect()
  }, [])

  return (
    <TooltipProvider delayDuration={300}>
      <AppShell />
    </TooltipProvider>
  )
}
