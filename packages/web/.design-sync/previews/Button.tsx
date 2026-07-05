import { Button } from '@cascade/web'
import { Search, Plus, ChevronRight, Loader2, Trash2 } from 'lucide-react'

export const Variants = () => (
  <div className="flex flex-wrap items-center gap-3">
    <Button>Deploy</Button>
    <Button variant="secondary">Preview</Button>
    <Button variant="outline">Cancel</Button>
    <Button variant="ghost">Settings</Button>
    <Button variant="destructive">Delete project</Button>
    <Button variant="link">Learn more</Button>
  </div>
)

export const Sizes = () => (
  <div className="flex flex-wrap items-center gap-3">
    <Button size="xs">Extra small</Button>
    <Button size="sm">Small</Button>
    <Button size="default">Default</Button>
    <Button size="lg">Large</Button>
  </div>
)

export const WithIcon = () => (
  <div className="flex flex-wrap items-center gap-3">
    <Button><Search /> Search files</Button>
    <Button variant="secondary"><Plus /> New file</Button>
    <Button variant="outline">Continue <ChevronRight /></Button>
    <Button size="icon" variant="outline" aria-label="Delete"><Trash2 /></Button>
  </div>
)

export const States = () => (
  <div className="flex flex-wrap items-center gap-3">
    <Button disabled>Disabled</Button>
    <Button disabled><Loader2 className="animate-spin" /> Deploying…</Button>
    <Button variant="outline" disabled>Unavailable</Button>
  </div>
)
