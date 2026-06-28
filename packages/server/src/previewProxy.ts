// previewProxy.ts — a tiny HTTP + WebSocket reverse proxy (M5.2) that gives the live preview a STABLE origin
// (e.g. http://localhost:4320) instead of the container's random published port. It forwards to whichever
// preview is currently active — one at a time, which is fine for a single-user builder. Because the iframe
// is now same-origin as the dev server, Vite's HMR websocket works through the proxy (raw upgrade piping)
// without the app needing to know the random port. Server-only; no app concepts leak to core.

import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http'
import { connect, type Socket } from 'node:net'

// Injected into the previewed app's HTML so build/runtime errors surface in the Problems tab (M7+). It posts
// to the parent window (the Cascade web app) across origins via postMessage. Catches: thrown errors,
// unhandled promise rejections, and Vite's build-error overlay (which it also clears when the build recovers).
const ERROR_CAPTURE = `<script>(function(){
  function send(p){ try{ parent.postMessage({ __cascade:'preview-error', payload:p }, '*') }catch(e){} }
  addEventListener('error', function(e){ if(e&&e.message) send({ kind:'runtime', message:e.message, file:(e.filename||'').split('/').slice(-2).join('/'), line:e.lineno||0, col:e.colno||0 }); }, true);
  addEventListener('unhandledrejection', function(e){ var r=e&&e.reason; send({ kind:'runtime', message:(r&&r.message)||String(r), file:'', line:0, col:0 }); });
  function overlay(){ var el=document.querySelector('vite-error-overlay'); if(!el||!el.shadowRoot) return null; var m=el.shadowRoot.querySelector('.message'); var f=el.shadowRoot.querySelector('.file'); return { kind:'build', message:((m&&m.textContent)||'Build error').trim().slice(0,500), file:((f&&f.textContent)||'').trim() }; }
  var last='';
  new MutationObserver(function(){ var o=overlay(); if(o){ var k=o.message+o.file; if(k!==last){ last=k; send(o); } } else if(last){ last=''; send({ kind:'build-cleared' }); } }).observe(document.documentElement, { childList:true, subtree:true });
})();</script>`

export class PreviewProxy {
  private targetPort: number | null = null // the active preview container's host port, or null when none
  private readonly server = createServer((req, res) => this.proxyHttp(req, res))

  constructor(private readonly port: number) {
    this.server.on('upgrade', (req, socket, head) => this.proxyUpgrade(req, socket as Socket, head))
  }

  /** Point the proxy at a container's published host port (null when no preview is running). */
  setTarget(hostPort: number | null): void {
    this.targetPort = hostPort
  }

  listen(): void {
    this.server.listen(this.port, '127.0.0.1')
  }

  private proxyHttp(req: IncomingMessage, res: ServerResponse): void {
    const target = this.targetPort
    if (!target) {
      res.writeHead(502)
      res.end('No preview running')
      return
    }
    const upstream = request({ host: '127.0.0.1', port: target, method: req.method, path: req.url, headers: req.headers }, (up) => {
      // Inject the error-capture script into the app's HTML so build/runtime errors reach the Problems tab.
      const ct = String(up.headers['content-type'] ?? '')
      const injectable = req.method === 'GET' && ct.includes('text/html') && !up.headers['content-encoding']
      if (!injectable) {
        res.writeHead(up.statusCode ?? 502, up.headers)
        up.pipe(res)
        return
      }
      const chunks: Buffer[] = []
      up.on('data', (c: Buffer) => chunks.push(c))
      up.on('end', () => {
        let html = Buffer.concat(chunks).toString('utf8')
        html = html.includes('</head>') ? html.replace('</head>', `${ERROR_CAPTURE}</head>`) : ERROR_CAPTURE + html
        const headers = { ...up.headers }
        delete headers['content-length'] // body length changed
        res.writeHead(up.statusCode ?? 200, { ...headers, 'content-length': Buffer.byteLength(html) })
        res.end(html)
      })
    })
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502)
      res.end('Preview unreachable')
    })
    req.pipe(upstream)
  }

  // HMR (and any) websocket: open a raw TCP socket to the container and pipe both directions, replaying the
  // original upgrade request line + headers so the dev server completes the handshake.
  private proxyUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    const target = this.targetPort
    if (!target) {
      socket.destroy()
      return
    }
    const upstream = connect(target, '127.0.0.1', () => {
      const headers = Object.entries(req.headers)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
        .join('\r\n')
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers}\r\n\r\n`)
      if (head?.length) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  }
}
