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
  private queue: WireMessage[] = [] // messages enqueued while the socket isn't OPEN; flushed on (re)open
  private closed = false // set by close() so an intentional teardown doesn't reconnect
  constructor(
    // Re-resolved before EACH (re)connect so we pick up a fresh per-run auth token after a server restart (M7).
    private readonly urlProvider: () => Promise<string>,
    private readonly onEvent: (e: WireEvent) => void,
    private readonly onConnected: (connected: boolean) => void,
  ) {}

  async connect() {
    if (this.closed) return
    let url: string
    try {
      url = await this.urlProvider()
    } catch {
      if (!this.closed) setTimeout(() => this.connect(), 1000) // server/token not ready — retry
      return
    }
    if (this.closed) return
    const ws = new WebSocket(url)
    this.ws = ws
    ws.onopen = () => {
      // Flush anything queued while connecting (e.g. the project `open` sent during the initial load), so it
      // isn't silently dropped.
      const pending = this.queue
      this.queue = []
      for (const m of pending) ws.send(JSON.stringify(m))
      this.onConnected(true)
    }
    ws.onclose = () => {
      this.onConnected(false)
      if (!this.closed) setTimeout(() => this.connect(), 1000) // reconnect unless we deliberately closed
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
    else this.queue.push(msg) // not open yet → deliver on the next open
  }

  /** Tear down for good (React unmount / HMR): stop reconnecting and close the socket. Prevents a storm of
   *  orphaned connections from StrictMode double-mounts and hot reloads. */
  close() {
    this.closed = true
    this.ws?.close()
  }
}
