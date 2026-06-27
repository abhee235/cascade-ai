// wsClient.ts — the browser's connection to @cascade/server. It speaks the wire protocol the server relays:
// core session events (ActivityEvent) AND app/builder events (BuilderEvent), and sends InboundMessage /
// BuilderCommand. Auto-reconnects so a server restart is seamless.

import type { ActivityEvent, InboundMessage } from '@cascade/core'
import type { BuilderEvent, BuilderCommand } from '@cascade/app-protocol'

/** Everything the server can push: a core session event OR an app/builder event. */
export type WireEvent = ActivityEvent | BuilderEvent
/** Everything the client can send: a core session message OR an app/builder command. */
export type WireMessage = InboundMessage | BuilderCommand

export class WsClient {
  private ws?: WebSocket
  constructor(
    private readonly url: string,
    private readonly onEvent: (e: WireEvent) => void,
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
        this.onEvent(JSON.parse(ev.data) as WireEvent)
      } catch {
        /* ignore */
      }
    }
  }

  send(msg: WireMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }
}
