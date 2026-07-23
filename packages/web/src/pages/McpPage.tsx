// McpPage.tsx — "Connectors": a browsable gallery of remote tools the agent can use, added via MCP over
// HTTPS (ADR-071). Web-safe by design — a connector is a URL Cascade calls, never a command it runs.
//
// Click any card to open its EDITOR dialog: set/rotate the API key, change the endpoint (self-hosted),
// enable/disable, or disconnect. The key is stored separately from the endpoint (server-side), so you can
// change the host without re-entering the key, or rotate the key without touching the host — and the key is
// never sent back to the browser (the editor shows only "key is set").

import { useEffect, useMemo, useState } from 'react'
import { Plus, Search, Check, Loader2, AlertTriangle, Power, Trash2, ExternalLink } from 'lucide-react'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { McpServerInfo } from '@cascade/app-protocol'
import tavilyLogo from '@/assets/connectors/tavily.png'
import context7Logo from '@/assets/connectors/context7.png'
import deepwikiLogo from '@/assets/connectors/deepwiki.png'
import gitmcpLogo from '@/assets/connectors/gitmcp.png'
import huggingfaceLogo from '@/assets/connectors/huggingface.png'

interface CatalogEntry {
  name: string // connector id + display name
  category: string
  description: string
  url: string // the CLEAN endpoint (no key)
  logo: string
  keyLabel?: string // present ⇒ needs a key; label for the field
  apiKeyIn?: string // how the key is applied ('query:<param>' | 'header:<name>' | 'bearer')
  keyDocsUrl?: string // where to get the key
}

// Verified live (2026-07-23): each connects and exposes real tools. Extend as more hosted HTTP MCPs appear.
const CATALOG: CatalogEntry[] = [
  { name: 'Tavily', category: 'Web search', description: 'Search the live web and extract page content — for current facts and real data the model was not trained on.', url: 'https://mcp.tavily.com/mcp/', logo: tavilyLogo, keyLabel: 'Tavily API key', apiKeyIn: 'query:tavilyApiKey', keyDocsUrl: 'https://app.tavily.com/' },
  { name: 'Context7', category: 'Docs', description: 'Up-to-date documentation for any library — resolve a package, then query its current docs on demand.', url: 'https://mcp.context7.com/mcp', logo: context7Logo },
  { name: 'DeepWiki', category: 'Docs', description: 'Ask natural-language questions about any public GitHub repo — indexed, wiki-style documentation.', url: 'https://mcp.deepwiki.com/mcp', logo: deepwikiLogo },
  { name: 'GitMCP', category: 'Docs', description: 'Fetch and search documentation and code for any GitHub project.', url: 'https://gitmcp.io/docs', logo: gitmcpLogo },
  { name: 'Hugging Face', category: 'ML', description: 'Search models, datasets, and Spaces on the Hugging Face Hub.', url: 'https://huggingface.co/mcp', logo: huggingfaceLogo },
]

function Logo({ src, alt, className }: { src?: string; alt: string; className?: string }) {
  return (
    <div className={cn('flex shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-background', className)}>
      {src ? <img src={src} alt={alt} className="h-full w-full object-contain p-1.5" /> : <span className="text-md font-bold text-muted-foreground">{alt.slice(0, 1)}</span>}
    </div>
  )
}

function StatusChip({ status, disabled }: { status?: McpServerInfo['status']; disabled?: boolean }) {
  if (disabled) return <span className="inline-flex items-center gap-1 text-sm text-muted-foreground/50"><Power className="h-3 w-3" /> off</span>
  const m = {
    ready: { icon: Check, cls: 'text-emerald-500', label: 'connected' },
    connecting: { icon: Loader2, cls: 'text-blue-500 animate-spin', label: 'connecting' },
    failed: { icon: AlertTriangle, cls: 'text-red-500', label: 'error' },
  } as const
  const v = m[status as keyof typeof m]
  if (!v) return <span className="inline-flex items-center gap-1 text-sm text-emerald-500"><Check className="h-3 w-3" /> added</span>
  return <span className={cn('inline-flex items-center gap-1 text-sm', v.cls)}><v.icon className="h-3 w-3" /> {v.label}</span>
}

export function McpPage() {
  const { mcpServers, listMcpServers, addMcpServer, removeMcpServer, toggleMcpServer } = useStore()
  const [tab, setTab] = useState<'browse' | 'custom'>('browse')
  const [query, setQuery] = useState('')

  useEffect(() => {
    listMcpServers()
    const t = setInterval(listMcpServers, 4000)
    return () => clearInterval(t)
  }, [listMcpServers])

  const byName = useMemo(() => new Map(mcpServers.map((s) => [s.name, s])), [mcpServers])
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return CATALOG.filter((c) => !q || c.name.toLowerCase().includes(q) || c.category.toLowerCase().includes(q) || c.description.toLowerCase().includes(q))
  }, [query])

  // ── Editor dialog ───────────────────────────────────────────────────────────────────────────────────
  const [editing, setEditing] = useState<CatalogEntry | null>(null)
  const [endpoint, setEndpoint] = useState('')
  const [apiKey, setApiKey] = useState('')
  const live = editing ? byName.get(editing.name) : undefined
  const exists = !!live

  const openEditor = (c: CatalogEntry) => {
    setEditing(c)
    setEndpoint(byName.get(c.name)?.url ?? c.url) // prefill the current endpoint (or the catalog default)
    setApiKey('') // never prefilled — we don't have the value; blank means "keep"
  }
  const save = () => {
    if (!editing) return
    // A typed key SETS/rotates it; blank leaves it undefined, which the server reads as "keep the existing
    // key" (or "no key" for a fresh free connector).
    addMcpServer(editing.name, endpoint.trim() || editing.url, { apiKey: apiKey.trim() || undefined, apiKeyIn: editing.apiKeyIn })
    setEditing(null)
  }
  // A brand-new keyed connector must get a key before it can connect; editing one may leave it blank (= keep).
  const needsKeyFirst = !!editing?.keyLabel && !exists && !apiKey.trim()

  // ── Custom tab ──────────────────────────────────────────────────────────────────────────────────────
  const [cName, setCName] = useState('')
  const [cUrl, setCUrl] = useState('')
  const [cKey, setCKey] = useState('')
  const canAddCustom = cName.trim() && /^https?:\/\//i.test(cUrl.trim())
  const addCustom = () => {
    if (!canAddCustom) return
    addMcpServer(cName.trim(), cUrl.trim(), cKey.trim() ? { apiKey: cKey.trim(), apiKeyIn: 'bearer' } : undefined)
    setCName(''), setCUrl(''), setCKey('')
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-10">
        <h1 className="text-3xl font-bold tracking-tight">Connect your tools</h1>
        <p className="mt-2 max-w-lg text-muted-foreground">
          Give your agent extra abilities — web search, live docs, and more. Click a connector to set it up, or add any MCP server by URL. Tools join every build; API keys stay on the server.
        </p>

        <div className="mt-6 inline-flex gap-1 rounded-lg bg-muted p-1">
          {(['browse', 'custom'] as const).map((t) => (
            <button key={t} type="button" onClick={() => setTab(t)} className={cn('rounded-md px-4 py-1.5 text-sm font-medium transition-colors', tab === t ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
              {t === 'browse' ? 'Browse' : 'Custom'}
            </button>
          ))}
        </div>

        {tab === 'browse' ? (
          <>
            <div className="relative mt-4">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input placeholder="Search connectors…" value={query} onChange={(e) => setQuery(e.target.value)} className="pl-9" />
            </div>

            <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {filtered.map((c) => {
                const s = byName.get(c.name)
                return (
                  <button key={c.name} type="button" onClick={() => openEditor(c)} className="flex items-start gap-3 rounded-xl border border-border p-3 text-left transition-colors hover:border-ring/60 hover:bg-accent/40">
                    <Logo src={c.logo} alt={c.name} className="h-15 w-15" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-semibold">{c.name}</span>
                        {s && <StatusChip status={s.status} disabled={s.disabled} />}
                      </div>
                      <div className="text-sm text-muted-foreground">{c.category}</div>
                      <p className="mt-1 line-clamp-2 text-sm text-muted-foreground/90">{c.description}</p>
                    </div>
                    <span className="mt-0.5 rounded-md p-1 text-muted-foreground">{s ? <span className="text-sm">edit</span> : <Plus className="h-4 w-4" />}</span>
                  </button>
                )
              })}
              {filtered.length === 0 && <div className="col-span-full py-8 text-center text-sm text-muted-foreground/70">No connectors match “{query}”. Try the Custom tab for any MCP URL.</div>}
            </div>

            {/* Custom connectors not in the catalog */}
            {mcpServers.some((s) => !CATALOG.find((c) => c.name === s.name)) && (
              <div className="mt-6">
                <div className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Your custom connectors</div>
                <div className="mt-2 rounded-lg border border-border">
                  {mcpServers
                    .filter((s) => !CATALOG.find((c) => c.name === s.name))
                    .map((s) => (
                      <div key={s.name} className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate font-medium">{s.name}</span>
                            <StatusChip status={s.status} disabled={s.disabled} />
                            {typeof s.toolCount === 'number' && s.status === 'ready' && <span className="text-sm text-muted-foreground">· {s.toolCount} tools</span>}
                          </div>
                          <div className="truncate font-mono text-sm text-muted-foreground">{s.url}{s.hasKey ? '  · key set' : ''}</div>
                        </div>
                        <Button variant="ghost" size="icon-sm" title={s.disabled ? 'Enable' : 'Disable'} onClick={() => toggleMcpServer(s.name, !s.disabled)}><Power className={cn('h-4 w-4', !s.disabled && 'text-emerald-500')} /></Button>
                        <Button variant="ghost" size="icon-sm" title="Remove" onClick={() => removeMcpServer(s.name)}><Trash2 className="h-4 w-4 text-muted-foreground hover:text-red-500" /></Button>
                      </div>
                    ))}
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="mt-4 space-y-3 rounded-xl border border-border p-4">
            <p className="text-sm text-muted-foreground">Add any MCP server that speaks HTTP. A connector is a <strong>remote URL</strong> Cascade calls — it never runs a command, so it's safe to expose.</p>
            <Input placeholder="name (e.g. my-search)" value={cName} onChange={(e) => setCName(e.target.value)} />
            <Input placeholder="https://mcp.example.com/mcp/" value={cUrl} onChange={(e) => setCUrl(e.target.value)} className="font-mono text-sm" />
            <div>
              <Input placeholder="API key — sent as Authorization: Bearer …  (optional)" type="password" value={cKey} onChange={(e) => setCKey(e.target.value)} className="font-mono text-sm" />
              <p className="mt-1 text-sm text-muted-foreground">If the key goes in the URL instead, put it there and leave this blank. Kept server-side.</p>
            </div>
            <div className="flex justify-end"><Button onClick={addCustom} disabled={!canAddCustom} className="gap-1.5"><Plus className="h-4 w-4" /> Add connector</Button></div>
          </div>
        )}
      </div>

      {/* Editor dialog */}
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-md">
          {editing && (
            <>
              <DialogHeader>
                <div className="flex items-center gap-3">
                  <Logo src={editing.logo} alt={editing.name} className="h-10 w-10" />
                  <div>
                    <DialogTitle className="flex items-center gap-2">{editing.name} {exists && <StatusChip status={live?.status} disabled={live?.disabled} />}</DialogTitle>
                    <DialogDescription className="text-sm">{editing.category}</DialogDescription>
                  </div>
                </div>
              </DialogHeader>

              <p className="text-sm text-muted-foreground">{editing.description}</p>
              {exists && live?.status === 'failed' && live.error && <p className="rounded bg-red-500/10 px-2 py-1 text-sm text-red-500">{live.error}</p>}
              {exists && live?.status === 'ready' && <p className="text-sm text-muted-foreground">{live.toolCount ?? 0} tools available.</p>}

              <div className="space-y-3">
                {editing.keyLabel && (
                  <div>
                    <label className="mb-1 flex items-center justify-between text-sm font-medium">
                      <span>{editing.keyLabel}</span>
                      {editing.keyDocsUrl && <a href={editing.keyDocsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">get a key <ExternalLink className="h-3 w-3" /></a>}
                    </label>
                    <Input autoFocus type="password" placeholder={live?.hasKey ? '•••••••• set — enter a new key to rotate, or leave blank to keep' : 'paste your key'} value={apiKey} onChange={(e) => setApiKey(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !needsKeyFirst && save()} className="font-mono text-sm" />
                    <p className="mt-1 text-sm text-muted-foreground">{live?.hasKey ? 'A key is already set (never shown). Type a new one only to rotate it.' : 'Stored on the server, never shown again.'}</p>
                  </div>
                )}
                <div>
                  <label className="mb-1 block text-sm font-medium">Endpoint</label>
                  <Input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} className="font-mono text-sm" />
                  <p className="mt-1 text-sm text-muted-foreground">Change this to point at a self-hosted instance. The key (if any) is applied separately, so editing the host keeps it.</p>
                </div>
              </div>

              <DialogFooter className="gap-2 sm:gap-2">
                {exists && (
                  <div className="mr-auto flex gap-2">
                    <Button variant="secondary" size="sm" onClick={() => toggleMcpServer(editing.name, !live?.disabled)}>{live?.disabled ? 'Enable' : 'Disable'}</Button>
                    <Button variant="ghost" size="sm" className="text-red-500 hover:text-red-500" onClick={() => { removeMcpServer(editing.name); setEditing(null) }}>Disconnect</Button>
                  </div>
                )}
                <Button onClick={save} disabled={needsKeyFirst} className="gap-1.5">
                  <Plus className="h-4 w-4" /> {exists ? 'Save changes' : 'Connect'}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
