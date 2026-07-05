import { Textarea } from '@cascade/web'

export const Default = () => (
  <div className="grid max-w-sm gap-2">
    <label htmlFor="msg" className="text-sm font-medium">Message</label>
    <Textarea id="msg" placeholder="Describe what you want to build…" rows={4} />
  </div>
)

export const States = () => (
  <div className="grid max-w-sm gap-3">
    <Textarea defaultValue={"Build a landing page with a hero,\nfeature grid, and pricing table."} rows={3} />
    <Textarea placeholder="Disabled" disabled rows={2} />
  </div>
)
