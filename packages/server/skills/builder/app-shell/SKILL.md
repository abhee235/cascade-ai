---
name: app-shell
description: The screens every app needs whatever it sells — sign-in, account, settings, notifications, search results — and the four states a data view can be in (loading, empty, error, 404). The shapes, the blocks, and the one distinction models get wrong.
whenToUse: Load when the task mentions ANY of: settings, preferences, account page, profile page, notifications, search page, search results, filters, 404, not found, error state, empty state, loading state, skeleton, or "the app needs a proper shell". Also load whenever you are about to render a list that could be empty or could fail.
---
# The app shell — the screens that are not the product

Every app ships these, and they are where scaffolded apps look worst: a settings page that is a ragged
column of inputs, a search page that says "No results" when the request actually failed, a 404 that is a
blank white screen. None of it is hard; all of it is skipped. Build these from the blocks below.

Every screen here exists as one working page — `Skill {name: "app-shell", file: "reference/pages.md"}` is
its verbatim source, including all four states side by side. Read it when a shape is unclear.

## The four states — the one distinction that matters

A data view is in exactly ONE of four states. Picking the wrong block tells the user to do the wrong
thing, which is worse than showing nothing:

| State | Cause | Block | The way out it offers |
|---|---|---|---|
| **loading** | the request is in flight | `<SkeletonList shape="rows\|cards\|stats">` | none — it just holds the layout still |
| **empty** | the request WORKED, there is no data | `<EmptyState>` | "create your first…" |
| **error** | the request FAILED | `<ErrorState>` | **retry** |
| **404** | the route does not exist | `<ErrorState code="404">` | navigate away |

```tsx
if (loading) return <SkeletonList count={3} />
if (error) return <ErrorState icon={ShieldAlert} title="Couldn't load your documents"
  description="The request timed out. Your work is safe." action={<Button onClick={retry}><RefreshCw className="size-4" /> Try again</Button>} />
if (items.length === 0) return <EmptyState icon={Inbox} title="No documents yet"
  description="Create one and it will show up here." action={<Button onClick={create}>New document</Button>} />
return <ItemList items={items} />
```

Order matters: loading → error → empty → data. Checking `items.length === 0` first renders "nothing
here" during every load and after every failure.

A spinner is not a loading state. `<SkeletonList>` is in the SHAPE of the coming content, so the page
does not jump when data lands.

### Filtered-empty is not the same empty

A list that finds nothing because of a filter must say so and offer **clear filters** — never "create
your first document", which is a dead end when the document exists and is merely hidden.

```tsx
<EmptyState icon={SearchX}
  title={filtering ? 'No matches' : 'Nothing here yet'}
  description={filtering ? 'No document matches those filters.' : 'Documents you create will appear here.'}
  action={filtering ? <Button variant="outline" onClick={clear}>Clear filters</Button> : <Button>New document</Button>} />
```

## Settings and account — rows, not a form column

`<SettingRow>` stacked in a `divide-y rounded-xl border bg-card` container: name + one-line description
on the left, ONE control hard right. The common mistake is stacking the control under the label, which
turns a scannable list into a long ragged form.

```tsx
<div className="divide-y rounded-xl border bg-card">
  <SettingRow label="Theme" description="Match your system, or pin one." control={<Select …/>} />
  <SettingRow label="Compact rows" description="Fit more into tables and lists." control={<Switch />} />
  <SettingRow label="Billing" description="Team plan · renews 4 March" control={<Button variant="outline" size="sm">Manage</Button>} />
</div>
```

Group rows under quiet `text-sm font-medium text-muted-foreground` headings (Profile · Preferences ·
Danger zone). A destructive action lives in its OWN group with a `border-destructive/40` container —
never a red button sitting among ordinary ones, where it gets clicked by accident.

### Irreversible actions CONFIRM

Delete, revoke, cancel-the-plan, remove-a-teammate: one click must never be enough. Use `<AlertDialog>`
(not `<Dialog>` — the alert variant traps focus on the safe option and cannot be dismissed by clicking
the backdrop):

```tsx
<AlertDialog>
  <AlertDialogTrigger asChild><Button variant="destructive" size="sm">Delete</Button></AlertDialogTrigger>
  <AlertDialogContent>
    <AlertDialogHeader>
      <AlertDialogTitle>Delete your account?</AlertDialogTitle>
      <AlertDialogDescription>
        This permanently removes your profile and the 4 documents you own. Teammates lose access
        immediately. This cannot be undone.
      </AlertDialogDescription>
    </AlertDialogHeader>
    <AlertDialogFooter>
      <AlertDialogCancel>Keep my account</AlertDialogCancel>
      <AlertDialogAction variant="destructive">Delete everything</AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>
```

Name the CONSEQUENCE, not the mechanism — what disappears, who else is affected, and that it is
permanent. Label the buttons with the outcome ("Keep my account" / "Delete everything"), never
"Cancel"/"OK", so a misread costs nothing.

## Sign-in — one card, no chrome

`<AuthCard>` centres itself on a quiet ground and carries the brand. Auth pages have **no NavBar and no
Footer**: there is nothing to navigate to until the user is in. Label + Input pairs, ONE primary submit,
errors on submit (not on keystroke — see the `forms` skill), and a `footer` link to the opposite action
("No account? Create one"). For the session mechanism, load the `auth` skill.

## Search and notifications

Search is `<FilterBar>` over a `useMemo` list that does search AND filter in ONE derivation — never two
lists kept in sync. Active filters show as chips so the user can see what is hiding their data.

Notifications are a `divide-y` card of rows: avatar, one sentence naming who did what, a relative
timestamp, and an unread dot. Preferences for them are `<SettingRow>` + `<Switch>`.

## Acceptance — check each before you call it done

- [ ] Every list view renders all four states — force each one by hand and LOOK at it.
- [ ] The error state's action retries; the 404's action navigates. Neither is a dead end.
- [ ] Filtered-empty offers "clear filters", not "create your first".
- [ ] Loading is a skeleton in the content's shape; the layout does not jump when data arrives.
- [ ] Settings rows are label-left / control-right and survive a narrow window (they stack, not squeeze).
- [ ] The destructive action is in its own group, visually separated.
- [ ] The sign-in page has no nav bar and no footer.
- [ ] `npm run build` green → `TemplateAudit {}` clean → `Browser {op:"open"}` → `Browser {op:"audit"}` clean.

## Out of scope unless asked

Real authentication, email delivery, push notifications, server-side search. These screens are UI over
client state; if the user asks to make them real, load the `backend` skill and call `ApplyPack`.
