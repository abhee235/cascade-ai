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

// Visual editing (M9): injected into the previewed app so the Cascade parent can drive an in-place
// editor over the cross-origin iframe. The parent toggles select mode; we map clicks to the nearest
// `data-cascade-loc` (stamped by the project's vite.config). A pure-text element becomes contenteditable IN
// PLACE (text selected); a small ✦ AI button floats at the selection's top-right corner. On commit we post the
// new text to the parent (which writes source → Vite HMR); the AI button posts a request to prefill the chat.
const SELECT_OVERLAY = `<script>(function(){
  var on=false, hover, selBox, aiBtn, editing=null, original='';
  function mk(css){ var d=document.createElement('div'); d.style.cssText=css; document.body.appendChild(d); return d; }
  function hoverBox(){ return hover||(hover=mk('position:fixed;z-index:2147483646;pointer-events:none;border:1px dashed #3b82f6;border-radius:2px;background:#3b82f614;display:none')); }
  function selectionBox(){ return selBox||(selBox=mk('position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #3b82f6;border-radius:3px;display:none')); }
  function place(d,el){ if(!el){ d.style.display='none'; return; } var r=el.getBoundingClientRect(); d.style.display='block'; d.style.left=r.left+'px'; d.style.top=r.top+'px'; d.style.width=r.width+'px'; d.style.height=r.height+'px'; }
  function aiButton(){ if(aiBtn) return aiBtn; aiBtn=document.createElement('button'); aiBtn.type='button'; aiBtn.textContent='\\u2726 AI'; aiBtn.style.cssText='position:fixed;z-index:2147483647;display:none;height:24px;padding:0 9px;font:600 12px system-ui,sans-serif;color:#fff;background:#3b82f6;border:0;border-radius:6px;box-shadow:0 2px 6px rgba(0,0,0,.35);cursor:pointer'; document.body.appendChild(aiBtn);
    aiBtn.addEventListener('mousedown', function(e){ e.preventDefault(); }); // keep focus on the editable (no premature blur)
    aiBtn.addEventListener('click', function(e){ e.preventDefault(); e.stopPropagation(); if(!editing) return; var el=editing; parent.postMessage({ __cascade:'preview-ai', loc:el.getAttribute('data-cascade-loc'), tag:el.tagName.toLowerCase(), text:(el.textContent||'').trim().slice(0,2000) }, '*'); stopEdit(); });
    return aiBtn; }
  function placeAi(el){ var b=aiButton(); b.style.display='inline-flex'; var r=el.getBoundingClientRect(), bw=b.offsetWidth||44, bh=b.offsetHeight||24; var top=r.top-bh-6; if(top<4) top=r.top+4; var left=r.right-bw; left=Math.max(4, Math.min(left, innerWidth-bw-4)); b.style.top=top+'px'; b.style.left=left+'px'; }
  function reposition(){ if(editing){ place(selectionBox(), editing); placeAi(editing); } }
  function target(e){ var el=e.target; return el&&el.closest? el.closest('[data-cascade-loc]') : null; }
  function onMove(e){ if(!on||editing) return; place(hoverBox(), target(e)); }
  function onClick(e){ if(!on) return; var el=target(e); if(el===editing) return; // clicking inside the editable: let the caret move
    if(!el){ return; } e.preventDefault(); e.stopPropagation();
    if(editing) commit(); startEdit(el); }
  function startEdit(el){
    editing=el; original=el.textContent||''; if(hover) hover.style.display='none';
    place(selectionBox(), el);
    if(el.children.length===0){ // pure-text leaf → edit in place; containers get the AI button only
      el.setAttribute('contenteditable','true'); el.style.outline='none'; el.focus();
      var s=getSelection(), rg=document.createRange(); rg.selectNodeContents(el); s.removeAllRanges(); s.addRange(rg);
      el.addEventListener('keydown', onKey, true); el.addEventListener('blur', commit, true); el.addEventListener('input', reposition, true);
    }
    placeAi(el);
  }
  function onKey(e){ if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); commit(); } else if(e.key==='Escape'){ e.preventDefault(); if(editing) editing.textContent=original; stopEdit(); } }
  function commit(){ if(!editing) return; var el=editing, text=(el.textContent||'').trim();
    if(text && text!==original.trim()) parent.postMessage({ __cascade:'preview-edit', loc:el.getAttribute('data-cascade-loc'), tag:el.tagName.toLowerCase(), text:text }, '*');
    stopEdit(); }
  function stopEdit(){ var el=editing; editing=null;
    if(el){ el.removeEventListener('keydown',onKey,true); el.removeEventListener('blur',commit,true); el.removeEventListener('input',reposition,true); el.removeAttribute('contenteditable'); el.style.outline=''; }
    if(selBox) selBox.style.display='none'; if(aiBtn) aiBtn.style.display='none'; }
  function setMode(v){ on=v; document.body.style.cursor=v?'crosshair':''; if(hover) hover.style.display='none'; if(!v) stopEdit(); }
  addEventListener('mousemove', onMove, true);
  addEventListener('click', onClick, true);
  addEventListener('scroll', reposition, true);
  addEventListener('message', function(e){ var d=e.data; if(!d||typeof d!=='object') return;
    if(d.__cascade==='select-mode'){ setMode(!!d.on); } else if(d.__cascade==='select-clear'){ stopEdit(); }
  });
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
        const inject = ERROR_CAPTURE + SELECT_OVERLAY
        html = html.includes('</head>') ? html.replace('</head>', `${inject}</head>`) : inject + html
        const headers = { ...up.headers }
        delete headers['content-length'] // body length changed
        // We rewrite this HTML on the fly (injected capture/overlay scripts); never let the browser cache it,
        // or a stale document keeps old injected scripts after the server updates them.
        res.writeHead(up.statusCode ?? 200, { ...headers, 'content-length': Buffer.byteLength(html), 'cache-control': 'no-store' })
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
