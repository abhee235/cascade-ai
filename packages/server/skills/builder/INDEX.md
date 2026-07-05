# Builder skills — read the one that matches your task BEFORE building

These are short, load-bearing recipes. Read ONLY what the current request needs (one Read each):

| file | read it when the request involves… |
|---|---|
| `architecture.md` | ANY build or feature — file layout, views, state placement (always read this first) |
| `design.md` | ANY UI work — the shadcn/ui kit, tokens, spacing, dark mode, empty/loading states |
| `data.md` | lists, catalogs, filtering, persistence, derived values (totals, counts) |
| `forms.md` | any form — inputs, validation, submit flows, error display |
| `auth.md` | login/signup/accounts (mock pattern — no backend) |
| `dashboard.md` | admin panels, stats, tables, charts-like layouts |
| `landing.md` | marketing/landing pages, hero sections, pricing |

User-added skills may exist in the parent folder (`.cascade/skills/*.md`) — consult them too; they
override these on conflict. Files under `base/` are managed by Cascade and reset on project open —
never edit them.
