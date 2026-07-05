# Design — this project uses shadcn/ui. Compose it; never hand-roll.

## The kit (already installed at `src/components/ui/` — import, don't recreate)

Button, Card(+Header/Title/Description/Content/Footer), Input, Label, Badge, Dialog, DropdownMenu,
Select, Tabs, Table, Textarea, Checkbox, Switch, Separator, Skeleton, Tooltip.

```tsx
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
```

**NEVER** write a raw `<button className="rounded bg-blue-600 …">` — that's `<Button>`. Never build a
modal from divs — that's `<Dialog>`. Icons: `import { ShoppingCart } from 'lucide-react'`.

## Color = tokens only. Never invent colors.

Use ONLY token utilities: `bg-background text-foreground`, `bg-card`, `bg-primary
text-primary-foreground`, `bg-muted text-muted-foreground`, `bg-secondary`, `text-destructive`,
`border-border`. NO `bg-blue-600`, no hex, no arbitrary values. The palette stays consistent and dark
mode works for free.

**Dark mode**: toggle the `dark` class on `document.documentElement`; persist with localStorage.
Because everything uses tokens, that one class restyles the whole app.

## Layout rhythm

- Page: `<main className="min-h-screen bg-background text-foreground">`, content in
  `<div className="mx-auto max-w-5xl p-6">`.
- Grids: `grid gap-4 sm:grid-cols-2 lg:grid-cols-3`. Stacks: `flex flex-col gap-4` (gap, not margins).
- Type scale: page title `text-2xl font-bold tracking-tight`, section `text-lg font-semibold`,
  secondary text `text-sm text-muted-foreground`. Nothing bigger than `text-3xl`.

## Every list view needs its states

- **Empty**: a centered `text-muted-foreground` message + a CTA button — never a blank region.
- **Feedback**: after an action, show it (badge count changes, a confirmation line, a disabled state).
- Disabled buttons for invalid actions (`disabled={cart.length === 0}`) instead of error popups.
