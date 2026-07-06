---
name: dashboard
description: Dashboard layouts: stat cards computed from real data, sortable kit tables with row actions, bar-style visuals without a chart library.
whenToUse: Load when the task mentions ANY of: dashboard, admin, panel, stats, metrics, KPIs, overview page, table of records, orders list, reports, analytics.
---
# Dashboards — stats, tables, admin layouts

## Page skeleton

Header row (title + primary action button) → stat cards row → content (table or cards):

```tsx
<div className="mx-auto max-w-6xl p-6 flex flex-col gap-6">
  <div className="flex items-center justify-between">
    <h1 className="text-2xl font-bold tracking-tight">Overview</h1>
    <Button>New item</Button>
  </div>
  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{/* stat cards */}</div>
  <Card>{/* table */}</Card>
</div>
```

## Stat card (repeat per metric — compute values from real data, never hardcode)

```tsx
<Card><CardHeader className="pb-2"><CardDescription>Revenue</CardDescription>
  <CardTitle className="text-3xl">${total.toFixed(2)}</CardTitle></CardHeader>
  <CardContent><p className="text-xs text-muted-foreground">+{growth}% from last week</p></CardContent></Card>
```

## Tables: the kit's Table, with real affordances

- `Table/TableHeader/TableRow/TableHead/TableBody/TableCell` from the kit.
- Right-align numeric columns (`className="text-right"`); status as `<Badge variant="secondary">`.
- Row actions in a `DropdownMenu` (⋯ button), not a row of loose buttons.
- Sorting: clickable TableHead toggling a `{ key, dir }` state + one `useMemo` sort. Filter/search
  above the table (data.md pattern).

## Bar-chart-like visuals without a chart library

Proportional divs are enough: `<div className="h-2 rounded bg-primary" style={{ width: pct + '%' }} />`
inside a labeled row per item. Use `--color-chart-*` tokens when several series need distinct colors.
