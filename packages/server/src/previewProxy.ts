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
// PLACE (text selected). A floating toolbar (font / size / bold / italic / align / color + ✦ AI) sits above the
// selection and edits the element's Tailwind className live; the new className/text is posted to the parent,
// which writes it to source (→ Vite HMR). The toolbar lives INSIDE the iframe so clicking it never blurs the
// contenteditable (cross-document focus loss).
const SELECT_OVERLAY = `<script>(function(){
  var on=false, hover, selBox, bar, editing=null, original='', sizePx=16;
  function mk(css){ var d=document.createElement('div'); d.style.cssText=css; document.body.appendChild(d); return d; }
  function hoverBox(){ return hover||(hover=mk('position:fixed;z-index:2147483646;pointer-events:none;border:1px dashed #3b82f6;border-radius:2px;background:#3b82f614;display:none')); }
  function selectionBox(){ return selBox||(selBox=mk('position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #3b82f6;border-radius:3px;display:none')); }
  function place(d,el){ if(!el){ d.style.display='none'; return; } var r=el.getBoundingClientRect(); d.style.display='block'; d.style.left=r.left+'px'; d.style.top=r.top+'px'; d.style.width=r.width+'px'; d.style.height=r.height+'px'; }
  function target(e){ var el=e.target; return el&&el.closest? el.closest('[data-cascade-loc]') : null; }

  // ── Tailwind className helpers ──
  var WEIGHT=/^font-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)$/;
  var BOLD=/^font-(semibold|bold|extrabold|black)$/;
  var FAMILY=/^font-(sans|serif|mono)$/;
  var ITAL=/^(italic|not-italic)$/;
  var ALIGN=/^text-(left|center|right|justify|start|end)$/;
  var SIZE=/^text-(xs|sm|base|lg|xl|[2-9]xl)$|^text-\\[[0-9.]+(px|rem|em|pt)\\]$/;
  var COLOR=/^text-\\[(#|rgb|hsl)|^text-(inherit|current|transparent|black|white|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(-[0-9]{2,3})?$/;
  function cls(el){ return (el.getAttribute('class')||'').split(/\\s+/).filter(Boolean); }
  function strip(a,re){ return a.filter(function(c){ return !re.test(c); }); }
  function setCls(el,a){ el.setAttribute('class', a.join(' ')); parent.postMessage({ __cascade:'set-class', loc:el.getAttribute('data-cascade-loc'), className:(el.getAttribute('class')||'') }, '*'); }
  function hex(rgb){ var m=(rgb||'').match(/[0-9]+/g); if(!m) return '#000000'; return '#'+m.slice(0,3).map(function(n){ return ('0'+(+n).toString(16)).slice(-2); }).join(''); }

  // ── floating toolbar ──
  function tb(html,title,fn){ var b=document.createElement('button'); b.type='button'; b.title=title; b.innerHTML=html; b.style.cssText='display:inline-flex;align-items:center;justify-content:center;min-width:24px;height:24px;padding:0 5px;border:0;background:transparent;border-radius:5px;color:#1f2937;font:600 13px system-ui,sans-serif;cursor:pointer'; b.onmousedown=function(e){ e.preventDefault(); }; b.onclick=function(e){ e.preventDefault(); e.stopPropagation(); fn(); }; return b; }
  function sep(){ var d=document.createElement('div'); d.style.cssText='width:1px;height:16px;background:#e5e7eb;margin:0 3px'; return d; }
  function alignSvg(t){ var p={left:'M2 3h12M2 7h8M2 11h11',center:'M2 3h12M4 7h8M3 11h10',right:'M2 3h12M6 7h8M3 11h11'}[t]; return '<svg width="14" height="14" viewBox="0 0 16 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="'+p+'"/></svg>'; }
  function buildBar(){ if(bar) return bar;
    bar=mk('position:fixed;z-index:2147483647;display:none;align-items:center;gap:1px;padding:3px;background:#fff;border:1px solid #e5e7eb;border-radius:9px;box-shadow:0 6px 22px rgba(0,0,0,.18)');
    bar.onmousedown=function(e){ e.preventDefault(); };
    var fam=document.createElement('select'); fam.title='Font'; fam.innerHTML='<option value="">Default</option><option value="sans">Sans</option><option value="serif">Serif</option><option value="mono">Mono</option>'; fam.style.cssText='height:24px;border:0;background:transparent;color:#1f2937;font:13px system-ui;cursor:pointer;outline:none'; fam.onmousedown=function(e){ e.stopPropagation(); }; fam.onchange=function(){ if(!editing) return; var a=strip(cls(editing),FAMILY); if(fam.value) a.push('font-'+fam.value); setCls(editing,a); }; bar._fam=fam; bar.appendChild(fam);
    bar.appendChild(sep());
    bar.appendChild(tb('\\u2212','Smaller',function(){ setSize(sizePx-1); }));
    var lbl=document.createElement('span'); lbl.style.cssText='min-width:36px;text-align:center;color:#1f2937;font:13px system-ui'; lbl.textContent='16px'; bar._size=lbl; bar.appendChild(lbl);
    bar.appendChild(tb('+','Larger',function(){ setSize(sizePx+1); }));
    bar.appendChild(sep());
    bar._b=tb('B','Bold',toggleBold); bar.appendChild(bar._b);
    bar._i=tb('<span style="font-style:italic">I</span>','Italic',toggleItalic); bar.appendChild(bar._i);
    bar.appendChild(sep());
    bar._al=[tb(alignSvg('left'),'Align left',function(){ setAlign('left'); }),tb(alignSvg('center'),'Align center',function(){ setAlign('center'); }),tb(alignSvg('right'),'Align right',function(){ setAlign('right'); })];
    bar._al.forEach(function(b){ bar.appendChild(b); });
    bar.appendChild(sep());
    var col=document.createElement('input'); col.type='color'; col.title='Text color'; col.style.cssText='width:24px;height:22px;padding:0;border:0;background:transparent;cursor:pointer'; col.onmousedown=function(e){ e.stopPropagation(); }; col.onchange=function(){ if(!editing) return; var a=strip(cls(editing),COLOR); a.push('text-['+col.value+']'); setCls(editing,a); }; bar._col=col; bar.appendChild(col);
    bar.appendChild(sep());
    bar.appendChild(tb('<span style="color:#3b82f6;font-weight:700">\\u2726 AI</span>','Edit with AI',function(){ if(!editing) return; parent.postMessage({ __cascade:'preview-ai', loc:editing.getAttribute('data-cascade-loc'), tag:editing.tagName.toLowerCase(), text:(editing.textContent||'').trim().slice(0,2000) }, '*'); stopEdit(); }));
    return bar; }
  function setSize(px){ if(!editing||px<6||px>240) return; sizePx=px; var a=strip(cls(editing),SIZE); a.push('text-['+px+'px]'); setCls(editing,a); if(bar) bar._size.textContent=px+'px'; }
  function toggleBold(){ if(!editing) return; var a=cls(editing), b=a.some(function(c){ return BOLD.test(c); }); a=strip(a,WEIGHT); if(!b) a.push('font-bold'); setCls(editing,a); syncBar(); }
  function toggleItalic(){ if(!editing) return; var a=cls(editing), it=a.indexOf('italic')>=0; a=strip(a,ITAL); if(!it) a.push('italic'); setCls(editing,a); syncBar(); }
  function setAlign(al){ if(!editing) return; var a=strip(cls(editing),ALIGN); a.push('text-'+al); setCls(editing,a); syncBar(); }
  function mark(b,active){ b.style.background=active?'#dbeafe':'transparent'; b.style.color=active?'#1d4ed8':'#1f2937'; }
  function syncBar(){ if(!bar||!editing) return; var cs=getComputedStyle(editing); sizePx=Math.round(parseFloat(cs.fontSize))||16; bar._size.textContent=sizePx+'px'; mark(bar._b,(+cs.fontWeight)>=600); mark(bar._i,cs.fontStyle==='italic'); var al=cs.textAlign; mark(bar._al[0],al==='left'||al==='start'); mark(bar._al[1],al==='center'); mark(bar._al[2],al==='right'||al==='end'); try{ bar._col.value=hex(cs.color); }catch(e){} var f=cls(editing).filter(function(c){ return FAMILY.test(c); })[0]; bar._fam.value=f?f.replace('font-',''):''; }
  function placeBar(el){ var b=buildBar(); b.style.display='inline-flex'; var r=el.getBoundingClientRect(), bw=b.offsetWidth||320, bh=b.offsetHeight||30; var top=r.top-bh-8; if(top<4) top=r.bottom+8; var left=Math.max(4, Math.min(r.left, innerWidth-bw-4)); b.style.top=top+'px'; b.style.left=left+'px'; }

  // ── selection + edit lifecycle ──
  function reposition(){ if(editing){ place(selectionBox(), editing); placeBar(editing); } }
  function onMove(e){ if(!on||editing) return; place(hoverBox(), target(e)); }
  function onClick(e){ if(!on) return; var el=target(e); if(el===editing) return; if(!el){ return; } e.preventDefault(); e.stopPropagation(); if(editing) commit(); startEdit(el); }
  function startEdit(el){
    editing=el; original=el.textContent||''; if(hover) hover.style.display='none';
    place(selectionBox(), el);
    if(el.children.length===0){ el.setAttribute('contenteditable','true'); el.style.outline='none'; el.focus(); var s=getSelection(), rg=document.createRange(); rg.selectNodeContents(el); s.removeAllRanges(); s.addRange(rg); el.addEventListener('keydown', onKey, true); el.addEventListener('blur', commit, true); el.addEventListener('input', reposition, true); }
    placeBar(el); syncBar();
  }
  function onKey(e){ if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); commit(); } else if(e.key==='Escape'){ e.preventDefault(); if(editing) editing.textContent=original; stopEdit(); } }
  function commit(){ if(!editing) return; var el=editing, text=(el.textContent||'').trim();
    if(el.children.length===0 && text && text!==original.trim()) parent.postMessage({ __cascade:'preview-edit', loc:el.getAttribute('data-cascade-loc'), tag:el.tagName.toLowerCase(), text:text }, '*');
    stopEdit(); }
  function stopEdit(){ var el=editing; editing=null;
    if(el){ el.removeEventListener('keydown',onKey,true); el.removeEventListener('blur',commit,true); el.removeEventListener('input',reposition,true); el.removeAttribute('contenteditable'); el.style.outline=''; }
    if(selBox) selBox.style.display='none'; if(bar) bar.style.display='none'; }
  function setMode(v){ on=v; document.body.style.cursor=v?'crosshair':''; if(hover) hover.style.display='none'; if(!v) stopEdit(); }
  addEventListener('mousemove', onMove, true);
  addEventListener('click', onClick, true);
  addEventListener('scroll', reposition, true);
  addEventListener('message', function(e){ var d=e.data; if(!d||typeof d!=='object') return;
    if(d.__cascade==='select-mode'){ setMode(!!d.on); } else if(d.__cascade==='select-clear'){ stopEdit(); }
    // Preview toolbar back/forward: the iframe is cross-origin to the Cascade shell, so the shell can't touch
    // its history directly — it posts here and we walk history INSIDE the app's own origin. Works for a router
    // AND for the view-union pattern once App uses useHistoryView (each view push adds a history entry).
    else if(d.__cascade==='nav'){ if(d.dir==='back') history.back(); else if(d.dir==='forward') history.forward(); }
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
