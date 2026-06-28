// ThemeDialog.tsx — "Customize theme" (M11): pick light/dark and a brand accent (presets or a custom color).
// Changes apply live and persist (localStorage); opened from the command palette or Settings.

import { Check, Moon, Sun } from 'lucide-react'
import { useStore } from '@/lib/store'
import { ACCENT_PRESETS } from '@/lib/theme'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

export function ThemeDialog() {
  const { customizeOpen, setCustomizeOpen, theme, toggleTheme, accent, setAccent } = useStore()

  return (
    <Dialog open={customizeOpen} onOpenChange={setCustomizeOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Customize theme</DialogTitle>
          <DialogDescription>Choose appearance and a brand accent. Changes apply instantly and are saved.</DialogDescription>
        </DialogHeader>

        {/* Appearance */}
        <div>
          <div className="mb-2 text-xs font-medium text-muted-foreground">Appearance</div>
          <div className="grid grid-cols-2 gap-2">
            {(['light', 'dark'] as const).map((t) => (
              <button
                key={t}
                onClick={() => theme !== t && toggleTheme()}
                className={cn(
                  'flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm capitalize transition-colors',
                  theme === t ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:bg-accent',
                )}
              >
                {t === 'light' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />} {t}
              </button>
            ))}
          </div>
        </div>

        {/* Accent */}
        <div>
          <div className="mb-2 text-xs font-medium text-muted-foreground">Accent color</div>
          <div className="flex flex-wrap items-center gap-2">
            {ACCENT_PRESETS.map((p) => {
              const active = (p.hex ?? null) === (accent ?? null)
              return (
                <button
                  key={p.name}
                  title={p.name}
                  onClick={() => setAccent(p.hex)}
                  className={cn('flex h-8 w-8 items-center justify-center rounded-full border transition-transform hover:scale-105', active ? 'border-foreground' : 'border-border')}
                  style={{ background: p.hex ?? 'transparent' }}
                >
                  {active && <Check className={cn('h-4 w-4', p.hex ? 'text-white' : 'text-foreground')} />}
                  {!p.hex && !active && <span className="text-[9px] text-muted-foreground">A</span>}
                </button>
              )
            })}
            {/* Custom color */}
            <label className="flex h-8 cursor-pointer items-center gap-1.5 rounded-full border border-border px-2 text-xs text-muted-foreground hover:bg-accent" title="Custom color">
              <span className="h-4 w-4 rounded-full border border-border" style={{ background: accent ?? 'conic-gradient(red,orange,yellow,lime,cyan,blue,magenta,red)' }} />
              Custom
              <input type="color" value={accent ?? '#3b82f6'} onChange={(e) => setAccent(e.target.value)} className="sr-only" />
            </label>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
