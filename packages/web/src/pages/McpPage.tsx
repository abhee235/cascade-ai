// McpPage.tsx — "Connectors": a browsable gallery of remote tools the agent can use, added via MCP over
// HTTPS (ADR-071). Web-safe by design — a connector is a URL Cascade calls, never a command it runs.
//
// Two tabs, mirroring the familiar "Easy connect / Custom" pattern: BROWSE a curated catalog of real,
// verified HTTP-MCP servers (one click, or one key), or add a CUSTOM MCP URL. Unlike a 3,000-app OAuth
// gallery, every card here genuinely connects — no dead links.

import { useEffect, useMemo, useState } from 'react'
import { Plug, Plus, Search, Check, Loader2, AlertTriangle, Power, Trash2, X, KeyRound } from 'lucide-react'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { McpServerInfo } from '@cascade/app-protocol'

interface CatalogEntry {
  name: string // the connector id (also its display name)
  category: string
  description: string
  url: string // {KEY} is substituted with the user's key (for keyed servers)
  keyLabel?: string // present ⇒ needs a key; placeholder text for the field
  color: string // icon accent
}

// Verified live (2026-07-23): each connects and exposes real tools. Extend as more hosted HTTP MCPs appear.
const CATALOG: CatalogEntry[] = [
  { name: 'Tavily', category: 'Web search', description: 'Search the live web and extract page content — for current facts and real data.', url: 'https://mcp.tavily.com/mcp/?tavilyApiKey={KEY}', keyLabel: 'Tavily API key (tavily.com)', color: '#3b82f6' },
  { name: 'Context7', category: 'Docs', description: 'Up-to-date documentation for any library — resolve a package, query its current docs.', url: 'https://mcp.context7.com/mcp', color: '#8b5cf6' },
  { name: 'DeepWiki', category: 'Docs', description: 'Ask questions about any public GitHub repo — indexed wiki-style docs.', url: 'https://mcp.deepwiki.com/mcp', color: '#10b981' },
  { name: 'GitMCP', category: 'Docs', description: 'Fetch and search documentation and code for any GitHub project.', url: 'https://gitmcp.io/docs', color: '#f59e0b' },
  { name: 'Hugging Face', category: 'ML', description: 'Search models, datasets, and Spaces on the Hugging Face Hub.', url: 'https://huggingface.co/mcp', color: '#eab308' },
]

function Icon({ name, color }: { name: string; color: string }) {
  return (
    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-sm font-bold text-white" style={{ background: color }}>
      {name.slice(0, 1)}
    </div>
  )
}

function StatusChip({ status, disabled }: { status?: McpServerInfo['status']; disabled?: boolean }) {
  if (disabled) return <span className="inline-flex items-center gap-1 text-xs text-muted-foreground/50"><Power className="h-3 w-3" /> off</span>
  const m = {
    ready: { icon: Check, cls: 'text-emerald-500', label: 'connected' },
    connecting: { icon: Loader2, cls: 'text-blue-500 animate-spin', label: 'connecting' },
    failed: { icon: AlertTriangle, cls: 'text-red-500', label: 'error' },
  } as const
  const v = m[status as keyof typeof m]
  if (!v) return <span className="text-xs text-muted-foreground">idle</span>
  return <span className={cn('inline-flex items-center gap-1 text-xs', v.cls)}><v.icon className="h-3 w-3" /> {v.label}</span>
}

export function McpPage() {
  const { mcpServers, listMcpServers, addMcpServer, removeMcpServer, toggleMcpServer } = useStore()
  const [tab, setTab] = useState<'browse' | 'custom'>('browse')
  const [query, setQuery] = useState('')
  const [pendingKey, setPendingKey] = useState<{ entry: CatalogEntry; value: string } | null>(null) // inline key entry for a catalog card

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

  const connectCatalog = (c: CatalogEntry, key?: string) => {
    const url = c.keyLabel ? c.url.replace('{KEY}', encodeURIComponent(key ?? '')) : c.url
    addMcpServer(c.name, url)
    setPendingKey(null)
  }

  // Custom-tab form
  const [cName, setCName] = useState('')
  const [cUrl, setCUrl] = useState('')
  const [cKey, setCKey] = useState('')
  const canAddCustom = cName.trim() && /^https?:\/\//i.test(cUrl.trim())
  const addCustom = () => {
    if (!canAddCustom) return
    addMcpServer(cName.trim(), cUrl.trim(), cKey.trim() ? { Authorization: `Bearer ${cKey.trim()}` } : undefined)
    setCName(''), setCUrl(''), setCKey('')
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <h1 className="text-3xl font-bold tracking-tight">Connect your tools</h1>
        <p className="mt-2 max-w-lg text-muted-foreground">
          Give your agent extra abilities — web search, live docs, and more. Pick a connector below, or add any MCP server by URL. Tools join every build; API keys stay on the server.
        </p>

        {/* Tabs */}
        <div className="mt-6 inline-flex gap-1 rounded-lg bg-muted p-1">
          {(['browse', 'custom'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn('rounded-md px-4 py-1.5 text-sm font-medium transition-colors', tab === t ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground')}
            >
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
                const live = byName.get(c.name)
                const connected = !!live
                const isKeying = pendingKey?.entry.name === c.name
                return (
                  <div key={c.name} className="rounded-xl border border-border p-3 transition-colors hover:border-ring/50">
                    <div className="flex items-start gap-3">
                      <Icon name={c.name} color={c.color} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-semibold">{c.name}</span>
                          {connected && <StatusChip status={live.status} disabled={live.disabled} />}
                        </div>
                        <div className="text-xs text-muted-foreground">{c.category}</div>
                        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground/90">{c.description}</p>
                      </div>
                      {!connected && !isKeying && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          title={c.keyLabel ? 'Connect (needs a key)' : 'Connect'}
                          onClick={() => (c.keyLabel ? setPendingKey({ entry: c, value: '' }) : connectCatalog(c))}
                        >
                          <Plus className="h-4 w-4" />
                        </Button>
                      )}
                      {connected && (
                        <div className="flex items-center gap-1">
                          <Button variant="ghost" size="icon-sm" title={live.disabled ? 'Enable' : 'Disable'} onClick={() => toggleMcpServer(c.name, !live.disabled)}>
                            <Power className={cn('h-4 w-4', !live.disabled && 'text-emerald-500')} />
                          </Button>
                          <Button variant="ghost" size="icon-sm" title="Disconnect" onClick={() => removeMcpServer(c.name)}>
                            <Trash2 className="h-4 w-4 text-muted-foreground hover:text-red-500" />
                          </Button>
                        </div>
                      )}
                    </div>

                    {/* Inline key entry */}
                    {isKeying && (
                      <div className="mt-3 flex items-center gap-2 border-t border-border pt-3">
                        <KeyRound className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <Input
                          autoFocus
                          type="password"
                          placeholder={c.keyLabel}
                          value={pendingKey.value}
                          onChange={(e) => setPendingKey({ entry: c, value: e.target.value })}
                          onKeyDown={(e) => e.key === 'Enter' && pendingKey.value.trim() && connectCatalog(c, pendingKey.value.trim())}
                          className="h-8 font-mono text-xs"
                        />
                        <Button size="sm" disabled={!pendingKey.value.trim()} onClick={() => connectCatalog(c, pendingKey.value.trim())}>
                          Connect
                        </Button>
                        <Button variant="ghost" size="icon-sm" onClick={() => setPendingKey(null)}>
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    )}
                    {isKeying && live?.status === 'failed' && live.error && <p className="mt-1 text-xs text-red-500">{live.error}</p>}
                  </div>
                )
              })}
              {filtered.length === 0 && <div className="col-span-full py-8 text-center text-sm text-muted-foreground/70">No connectors match “{query}”. Try the Custom tab for any MCP URL.</div>}
            </div>

            {/* Any custom connectors not in the catalog */}
            {mcpServers.some((s) => !CATALOG.find((c) => c.name === s.name)) && (
              <div className="mt-6">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Custom</div>
                <div className="mt-2 rounded-lg border border-border">
                  {mcpServers
                    .filter((s) => !CATALOG.find((c) => c.name === s.name))
                    .map((s) => (
                      <div key={s.name} className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate font-medium">{s.name}</span>
                            <StatusChip status={s.status} disabled={s.disabled} />
                            {typeof s.toolCount === 'number' && s.status === 'ready' && <span className="text-xs text-muted-foreground">· {s.toolCount} tools</span>}
                          </div>
                          <div className="truncate font-mono text-xs text-muted-foreground">{s.url ?? s.command}</div>
                        </div>
                        <Button variant="ghost" size="icon-sm" title={s.disabled ? 'Enable' : 'Disable'} onClick={() => toggleMcpServer(s.name, !s.disabled)}>
                          <Power className={cn('h-4 w-4', !s.disabled && 'text-emerald-500')} />
                        </Button>
                        <Button variant="ghost" size="icon-sm" title="Remove" onClick={() => removeMcpServer(s.name)}>
                          <Trash2 className="h-4 w-4 text-muted-foreground hover:text-red-500" />
                        </Button>
                      </div>
                    ))}
                </div>
              </div>
            )}
          </>
        ) : (
          /* Custom tab — any HTTPS MCP URL */
          <div className="mt-4 space-y-3 rounded-xl border border-border p-4">
            <p className="text-sm text-muted-foreground">
              Add any MCP server that speaks HTTP. A connector is a <strong>remote URL</strong> Cascade calls — it never runs a command, so it's safe to expose.
            </p>
            <Input placeholder="name (e.g. my-search)" value={cName} onChange={(e) => setCName(e.target.value)} />
            <Input placeholder="https://mcp.example.com/mcp/?apiKey=…" value={cUrl} onChange={(e) => setCUrl(e.target.value)} className="font-mono text-sm" />
            <div>
              <Input placeholder="API key for Authorization: Bearer …  (optional)" type="password" value={cKey} onChange={(e) => setCKey(e.target.value)} className="font-mono text-sm" />
              <p className="mt-1 text-xs text-muted-foreground">Only if the server uses a Bearer header (not needed when the key is already in the URL). Kept server-side.</p>
            </div>
            <div className="flex justify-end">
              <Button onClick={addCustom} disabled={!canAddCustom} className="gap-1.5">
                <Plus className="h-4 w-4" /> Add connector
              </Button>
            </div>
          </div>
        )}

        <p className="mt-8 flex items-center gap-1.5 text-xs text-muted-foreground/70">
          <Plug className="h-3.5 w-3.5" /> Connect a few now, or add them anytime. Tools appear to the agent on the next build.
        </p>
      </div>
    </div>
  )
}
