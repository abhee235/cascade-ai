import { Input } from '@cascade/web'

export const Text = () => (
  <div className="grid max-w-sm gap-2">
    <label htmlFor="email" className="text-sm font-medium">Email</label>
    <Input id="email" type="email" placeholder="you@example.com" />
  </div>
)

export const States = () => (
  <div className="grid max-w-sm gap-3">
    <Input placeholder="Default" />
    <Input defaultValue="cascade-web" />
    <Input placeholder="Disabled" disabled />
    <Input aria-invalid placeholder="Invalid value" />
  </div>
)

export const Types = () => (
  <div className="grid max-w-sm gap-3">
    <Input type="password" defaultValue="hunter2" />
    <Input type="number" defaultValue={42} />
    <Input type="file" />
  </div>
)
