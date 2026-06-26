// wsClient.ts — the browser's connection to @cascade/server. It speaks the EXACT same protocol the extension
// uses in-process: send InboundMessage, receive ActivityEvent. Auto-reconnects so a server restart is seamless.

import type { ActivityEvent, InboundMessage } from '@cascade/core'

export class WsClient {
  private ws?: WebSocket
  constructor(
    private readonly url: string,
    private readonly onEvent: (e: ActivityEvent) => void,
    private readonly onConnected: (connected: boolean) => void,
  ) {}

  connect() {
    const ws = new WebSocket(this.url)
    this.ws = ws
    ws.onopen = () => this.onConnected(true)
    ws.onclose = () => {
      this.onConnected(false)
      setTimeout(() => this.connect(), 1000) // reconnect
    }
    ws.onmessage = (ev) => {
      try {
        this.onEvent(JSON.parse(ev.data) as ActivityEvent)
      } catch {
        /* ignore */
      }
    }
  }

  send(msg: InboundMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }
}
