---
name: dashboard
description: Dashboards and admin apps — the AppShell chrome, KPI cards with real deltas, token-coloured charts, and a filterable sortable table. Every number derived from the rows beneath it.
whenToUse: Load BEFORE building any dashboard, admin, analytics, panel, console, reports, metrics/KPI, overview page, orders/records list, or internal tool. Also when the user says a dashboard looks flat or empty.
---
# Dashboards — chrome first, then numbers that are computed, never typed

Two failures make a dashboard look amateur, and neither is a compile error: it renders as a centred
column with no product chrome, and its numbers are hardcoded strings that never move when the data does.
This skill is the shape that avoids both.

## The contract — a dashboard is DONE when it has all four

| Layer | Block | Non-negotiable |
|---|---|---|
| chrome | `<AppShell>` | sidebar nav + sticky header. A signed-in view NEVER sits in a bare centred column |
| KPIs | `<StatCard>` × 3–4 | each value DERIVED via useMemo; each carries a delta and a takeaway line |
| trend | `<ChartCard>` × 1–2 | one series per card, `tone` picks the preset's chart colour |
| records | `<DataTable>` + `<FilterBar>` | sortable, filterable, right-aligned numerics, `<EmptyState>` when filtered to nothing |

The FULL working dashboard — AppShell chrome, KPI row, charts, filtered table — is one call away:
`Skill {name: "dashboard", file: "reference/pages.md"}`. Verbatim source of a page that renders, so it
cannot drift. Read it when a view fights you; copy its SHAPE, never its copy or data.

## The page assembly — copy this shape

```tsx
// ONE derived list does search + filter + sort. Never store what you can derive.
const rows = useMemo(() => {
  const q = query.trim().toLowerCase()
  const hits = RECORDS.filter((r) => (plan === 'all' || r.plan === plan) && (!q || r.customer.toLowerCase().includes(q)))
  return [...hits].sort((a, b) => (sort.dir === 'asc' ? 1 : -1) * String(a[sort.key]).localeCompare(String(b[sort.key])))
}, [query, plan, sort])
const revenue = useMemo(() => rows.filter((r) => r.status === 'paid').reduce((s, r) => s + r.amount, 0), [rows])

<AppShell
  brand={<><BarChart3 className="size-4 text-primary" /> Cadence</>}
  groups={[
    { items: [{ label: 'Overview', icon: LayoutDashboard, active: view === 'overview', onClick: () => setView('overview') }] },
    { heading: 'Billing', items: [{ label: 'Invoices', icon: FileText, onClick: () => setView('invoices') }] },
  ]}
  user={<div className="flex items-center gap-3"><Avatar className="size-8"><AvatarFallback>AR</AvatarFallback></Avatar>
    <div className="text-sm"><div className="font-medium">Ada Reyes</div><div className="text-xs text-muted-foreground">ada@…</div></div></div>}
  header="Overview"
  headerActions={<Button>New invoice</Button>}
>
  <div className="flex flex-col gap-6">
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard label="Revenue (paid)" value={`$${revenue.toLocaleString()}`} delta={12.4}
        trendLabel="Trending up this month" note="Paid invoices in the current view" icon={CreditCard} />
      {/* …3 more: volume, active users, and ONE inverse metric (failures/churn) with lowerIsBetter */}
    </div>

    <div className="grid gap-4 xl:grid-cols-[2fr_1fr]">
      <ChartCard title="Runs per day" description="Scheduled and manual." data={SERIES} kind="area" tone={1}
        action={<Tabs defaultValue="7d"><TabsList><TabsTrigger value="30d">30 days</TabsTrigger><TabsTrigger value="7d">7 days</TabsTrigger></TabsList></Tabs>} />
      <ChartCard title="Failures" description="Retried before alerting." data={FAILURES} kind="bar" tone={4} />
    </div>

    <DataTable
      columns={columns} rows={rows} rowKey={(r) => r.id} sort={sort}
      onSortChange={(key) => setSort((s) => ({ key, dir: s.key === key && s.dir === 'desc' ? 'asc' : 'desc' }))}
      toolbar={<><Tabs defaultValue="all"><TabsList><TabsTrigger value="all">All</TabsTrigger></TabsList></Tabs>
        <FilterBar query={query} onQueryChange={setQuery} placeholder="Search…" onClear={dirty ? clearAll : undefined}>
          <Select value={plan} onValueChange={setPlan}>…</Select>
        </FilterBar></>}
      caption={`${rows.length} of ${RECORDS.length} invoices`}
      empty={<EmptyState title="No invoices match" action={<Button variant="outline" onClick={clearAll}>Clear filters</Button>} />}
    />
  </div>
</AppShell>
```

Columns are data, not markup — `numeric: true` right-aligns and sets tabular figures:

```tsx
const columns: DataColumn<Invoice>[] = [
  { key: 'id', header: 'Invoice', cell: (r) => <span className="font-medium">{r.id}</span>, sortable: true },
  { key: 'status', header: 'Status', cell: (r) => <Badge variant={r.status === 'failed' ? 'destructive' : 'secondary'}>{r.status}</Badge> },
  { key: 'amount', header: 'Amount', cell: (r) => `$${r.amount.toLocaleString()}`, numeric: true, sortable: true },
]
```

## Charts

`<ChartCard>` already applies the design system — preset colour via `tone`, token grid/axis/tooltip, no Y
axis by default (the tooltip carries the exact number). One series per card; two cards beat one chart
with two lines. If you ever drop to raw recharts, colours must come from the PRESET variables
(`var(--chart-1)`, `var(--border)`) — `var(--color-chart-1)` does not exist at runtime and paints black.

## Acceptance — check each before you call it done

- [ ] The page is wrapped in `<AppShell>`; the sidebar's active item matches the current view.
- [ ] **≥3** StatCards, each with a delta, and at least one using `lowerIsBetter` for an inverse metric.
- [ ] Every KPI value comes from a `useMemo` over the same rows the table shows — change a filter and the
      numbers move. If a number never changes, it is decoration, and decoration is a lie here.
- [ ] **≥1** ChartCard with real series data (≥5 points).
- [ ] Table: clicking a sortable header reverses the order; the search box narrows the rows; a no-match
      search shows the `<EmptyState>`, never a blank card.
- [ ] `npm run build` green → `TemplateAudit` clean → `Browser {op:"open"}` → `Browser {op:"audit"}` clean.

## Out of scope unless asked

Real auth, server data, exports, column customisation, pagination beyond a caption line. A prototype
dashboard reads from seeded data in `src/lib/data.ts`; graduate with the `backend` skill + `ApplyPack`.
