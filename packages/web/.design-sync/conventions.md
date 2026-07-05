# Cascade Web UI — component & styling conventions

This library is **shadcn/ui (new-york style) on Tailwind v4**. Build every screen from the real
components exposed on `window.CascadeWebUI`; do layout and spacing with Tailwind utility classes that
resolve against the semantic design tokens below. Always prefer a library component over hand-rolled
markup — if a piece seems missing, compose it from the sub-parts, don't reinvent it.

## Setup / wrapping
- **Styles:** the design tokens, component styles, and Geist web fonts all ship through `styles.css`
  (it `@import`s `_ds_bundle.css` and the font host). Everything below resolves from it.
- **Wrap the app in `TooltipProvider`** so any `Tooltip` renders: `<TooltipProvider>…app…</TooltipProvider>`.
- **`Sidebar` must live inside `SidebarProvider`** (which also provides `useSidebar`, and pairs with
  `SidebarTrigger` / `SidebarInset`). Outside a provider it throws.
- **Dark mode:** put the `dark` class on a root ancestor (`<html class="dark">`). Every token flips
  automatically — never hard-code hex colors.

## Styling idiom — Tailwind utilities bound to semantic tokens
Style with these token-backed utilities (all are light+dark aware); do not use raw hex/named colors:
- Surfaces: `bg-background`/`text-foreground`, `bg-card`/`text-card-foreground`, `bg-popover`,
  `bg-muted`/`text-muted-foreground`, `bg-accent`/`text-accent-foreground`.
- Actions: `bg-primary`/`text-primary-foreground`, `bg-secondary`/`text-secondary-foreground`,
  `bg-destructive` (destructive text is `text-white`).
- Lines & focus: `border` (defaults to the `border` token), `ring-ring`, `bg-input`.
- Sidebar surface: `bg-sidebar`/`text-sidebar-foreground`, `bg-sidebar-accent`, `border-sidebar-border`.
- Charts: `bg-chart-1` … `bg-chart-5`. Radius: `rounded-sm|md|lg|xl` (from `--radius`).
- Type: `font-sans` (Geist), `font-mono` (Geist Mono). Size icons `size-4` inside controls.

## Components (all on `window.CascadeWebUI`)
- **Actions:** `Button` — `variant`: default | secondary | outline | ghost | destructive | link;
  `size`: default | xs | sm | lg | icon | icon-sm | icon-lg; `asChild`.
- **Forms:** `Input`, `Textarea`, `Select` (compose `SelectTrigger`+`SelectValue`, `SelectContent`,
  `SelectItem`, `SelectGroup`, `SelectLabel`, `SelectSeparator`).
- **Overlays:** `Dialog`, `Sheet`, `DropdownMenu`, `Tooltip`, `Command` — each composed from its
  sub-parts (e.g. `DialogTrigger`+`DialogContent`+`DialogHeader`/`DialogTitle`/`DialogDescription`/
  `DialogFooter`; `SheetContent side="left|right|top|bottom"`).
- **Layout:** `Tabs` (`TabsList`/`TabsTrigger`/`TabsContent`; `TabsList variant="line"`), `Separator`
  (`orientation`), `ScrollArea`, `Sidebar`. **Feedback:** `Skeleton` (size it via className).

Read each component's `<Name>.d.ts` for its exact prop contract and `<Name>.prompt.md` for a real
usage example before composing it.

## Gotcha — Button is not `forwardRef`
`Button` is a plain function component with no `forwardRef`. Do **not** use it as a Radix `asChild`
anchor for a positioned popover (`<DropdownMenuTrigger asChild><Button>…`, same for `TooltipTrigger`):
under React 18 the ref is dropped and the popover never anchors (renders off-screen). Instead style the
Radix trigger element directly with the button utilities, e.g.
`<DropdownMenuTrigger className="inline-flex h-9 items-center rounded-md border bg-background px-4 text-sm font-medium shadow-xs hover:bg-accent">`.

## One idiomatic example
```tsx
const { Tabs, TabsList, TabsTrigger, TabsContent, Input, Button, Separator } = window.CascadeWebUI

export function SettingsPanel() {
  return (
    <div className="mx-auto max-w-md rounded-lg border bg-card p-6 text-card-foreground">
      <h2 className="text-lg font-semibold">Project settings</h2>
      <Separator className="my-4" />
      <Tabs defaultValue="general">
        <TabsList>
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="domains">Domains</TabsTrigger>
        </TabsList>
        <TabsContent value="general" className="grid gap-3 pt-4">
          <label className="text-sm font-medium">Name</label>
          <Input defaultValue="cascade-web" />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline">Cancel</Button>
            <Button>Save changes</Button>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}
```
