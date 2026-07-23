// SettingsPage.tsx — the real settings surface: connection status (server, model, sandbox) from the server's
// capabilities greeting, and appearance (theme + accent). Model/provider SWITCHING and tools/MCP config are a
// later milestone (M8) — only live, truthful data is shown here.

import { Container, Moon, Palette, Plug, Sun } from 'lucide-react'
import { useStore } from '@/lib/store'
import { Button } from '@/components/ui/button'

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border px-4 py-3 text-sm last:border-b-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right font-medium">{children}</span>
    </div>
  )
}

export function SettingsPage() {
  const { connected, serverInfo, theme, toggleTheme, setCustomizeOpen } = useStore()

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-6 py-8">
        <h1 className="text-2xl font-semibold">Settings</h1>

        <section className="mt-6">
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <Plug className="h-3.5 w-3.5" /> Connection
          </div>
          <div className="mt-2 rounded-lg border border-border">
            <Row label="Server">
              <span className="font-mono text-xs">ws://{location.hostname}:4319</span>
            </Row>
            <Row label="Status">
              <span className={connected ? 'text-emerald-500' : 'text-yellow-500'}>{connected ? 'Connected' : 'Connecting…'}</span>
            </Row>
            <Row label="Model">{serverInfo?.model ?? '—'}</Row>
            <Row label="Sandbox">
              {serverInfo === null ? (
                '—'
              ) : serverInfo.sandbox ? (
                <span className="inline-flex items-center gap-1">
                  <Container className="h-3.5 w-3.5" /> Docker (isolated per project)
                </span>
              ) : (
                <span className="text-yellow-500">Host (no isolation — start Docker Desktop)</span>
              )}
            </Row>
          </div>
        </section>

        <section className="mt-6">
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <Palette className="h-3.5 w-3.5" /> Appearance
          </div>
          <div className="mt-2 rounded-lg border border-border">
            <Row label="Theme">
              <Button variant="secondary" size="sm" onClick={toggleTheme} className="gap-1.5">
                {theme === 'dark' ? <Moon className="h-3.5 w-3.5" /> : <Sun className="h-3.5 w-3.5" />}
                {theme === 'dark' ? 'Dark' : 'Light'} — switch
              </Button>
            </Row>
            <Row label="Accent color">
              <Button variant="secondary" size="sm" onClick={() => setCustomizeOpen(true)}>
                Customize…
              </Button>
            </Row>
          </div>
        </section>

        <p className="mt-6 text-xs text-muted-foreground">
          Switch models from the picker in a project; configure tool servers in the <strong>MCP</strong> panel. The default model is set with{' '}
          <code className="rounded bg-muted px-1 py-0.5">CASCADE_MODEL</code> when starting the server.
        </p>
      </div>
    </div>
  )
}
