// McpPage.tsx — "Connectors": remote tools the agent can call, added via MCP (ADR-071). Web-safe by design:
// a connector is an HTTPS MCP URL (+ optional API key/header) that Cascade calls over the network — NOT a
// command it runs, so a hosted server never executes a stranger's code. (Local stdio servers can still be
// hand-added to mcp.json on a machine you own; the extension uses those. This UI only creates HTTP ones.)

import { useEffect, useMemo, useState } from 'react'
import { Plug, Plus, Trash2, Check, Loader2, AlertTriangle, Power } from 'lucide-react'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { McpServerInfo } from '@cascade/app-protocol'

/** One-click presets for common HTTP connectors. `keyHint` names the credential the URL/header needs. */
const PRESETS: { label: string; hint: string; name: string; url: string; keyHint?: string }[] = [
  { label: 'Tavily (web search)', hint: 'Paste your Tavily key — get one free at tavily.com', name: 'tavily', url: 'https://mcp.tavily.com/mcp/?tavilyApiKey=', keyHint: 'append your key to the URL' },
  { label: 'Blank', hint: 'Any HTTPS MCP URL', name: '', url: '', keyHint: undefined },
]

function StatusBadge({ status, disabled }: { status?: McpServerInfo['status']; disabled?: boolean }) {
  const map = {
    ready: { icon: Check, cls: 'text-emerald-500', label: 'ready' },
    connecting: { icon: Loader2, cls: 'text-blue-500 animate-spin', label: 'connecting' },
    failed: { icon: AlertTriangle, cls: 'text-red-500', label: 'failed' },
    disabled: { icon: Power, cls: 'text-muted-foreground/50', label: 'disabled' },
    idle: { icon: Power, cls: 'text-muted-foreground', label: 'idle — connects on next build' },
  } as const
  const key = disabled ? 'disabled' : (status ?? 'idle')
  const v = map[key] ?? map.idle
  return (
    <span className={cn('inline-flex items-center gap-1 text-xs', v.cls)}>
      <v.icon className="h-3.5 w-3.5" /> {v.label}
    </span>
  )
}

export function McpPage() {
  const { mcpServers, listMcpServers, addMcpServer, removeMcpServer, toggleMcpServer, connected } = useStore()

  useEffect(() => {
    listMcpServers()
    const t = setInterval(listMcpServers, 4000) // statuses settle in the background
    return () => clearInterval(t)
  }, [listMcpServers])

  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [authKey, setAuthKey] = useState('') // optional Authorization: Bearer <key>, for servers that use a header

  const applyPreset = (p: (typeof PRESETS)[number]) => {
    setName(p.name)
    setUrl(p.url)
    setAuthKey('')
  }

  const canAdd = name.trim() && /^https?:\/\//i.test(url.trim())
  const submit = () => {
    if (!canAdd) return
    const headers = authKey.trim() ? { Authorization: `Bearer ${authKey.trim()}` } : undefined
    addMcpServer(name.trim(), url.trim(), headers)
    setName(''), setUrl(''), setAuthKey('')
  }

  const sorted = useMemo(() => [...mcpServers].sort((a, b) => a.name.localeCompare(b.name)), [mcpServers])

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-6 py-8">
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <Plug className="h-5 w-5" /> Connectors
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Give the agent extra tools — web search, and more — by connecting an MCP server over HTTPS. Its tools join every build. Keys stay on the
          server. Connectors are remote (a URL), never a command we run.
        </p>

        <section className="mt-6">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Connected</div>
          <div className="mt-2 rounded-lg border border-border">
            {sorted.length === 0 && <div className="px-4 py-6 text-center text-sm text-muted-foreground/70">{connected ? 'No connectors yet — add one below.' : 'Connecting…'}</div>}
            {sorted.map((s) => (
              <div key={s.name} className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{s.name}</span>
                    <StatusBadge status={s.status} disabled={s.disabled} />
                    {typeof s.toolCount === 'number' && s.status === 'ready' && <span className="text-xs text-muted-foreground">· {s.toolCount} tool{s.toolCount === 1 ? '' : 's'}</span>}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                    {s.url ?? s.command}
                    {s.headerKeys?.length ? `  ·  ${s.headerKeys.join(', ')}` : ''}
                    {s.command && !s.url ? '  · local (stdio)' : ''}
                  </div>
                  {s.status === 'failed' && s.error && <div className="mt-1 truncate text-xs text-red-500" title={s.error}>{s.error}</div>}
                </div>
                <Button variant="ghost" size="sm" title={s.disabled ? 'Enable' : 'Disable'} onClick={() => toggleMcpServer(s.name, !s.disabled)}>
                  <Power className={cn('h-4 w-4', !s.disabled && 'text-emerald-500')} />
                </Button>
                <Button variant="ghost" size="icon-sm" title="Remove" onClick={() => removeMcpServer(s.name)}>
                  <Trash2 className="h-4 w-4 text-muted-foreground hover:text-red-500" />
                </Button>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-6">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Add a connector</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <button key={p.label} type="button" onClick={() => applyPreset(p)} title={p.hint} className="rounded-full border border-border px-3 py-1 text-xs transition-colors hover:bg-accent">
                {p.label}
              </button>
            ))}
          </div>

          <div className="mt-3 space-y-3 rounded-lg border border-border p-4">
            <Input placeholder="name (e.g. tavily)" value={name} onChange={(e) => setName(e.target.value)} />
            <div>
              <Input placeholder="https://mcp.example.com/mcp/?apiKey=…" value={url} onChange={(e) => setUrl(e.target.value)} className="font-mono text-sm" />
              <p className="mt-1 text-xs text-muted-foreground">The HTTPS MCP URL. Some servers (Tavily) take the key in the URL; others use a header below.</p>
            </div>
            <div>
              <Input placeholder="API key for Authorization: Bearer …  (optional)" type="password" value={authKey} onChange={(e) => setAuthKey(e.target.value)} className="font-mono text-sm" />
              <p className="mt-1 text-xs text-muted-foreground">Only if the server authenticates with a Bearer header (not needed when the key is in the URL). Kept server-side.</p>
            </div>
            <div className="flex justify-end">
              <Button onClick={submit} disabled={!canAdd} className="gap-1.5">
                <Plus className="h-4 w-4" /> Add connector
              </Button>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
