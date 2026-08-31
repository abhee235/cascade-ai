---
name: forms
description: Kit-based forms: Label+Input pairs, on-submit validation, per-field error messages, success states.
whenToUse: Load BEFORE building any screen with input fields and a submit action: signup, login, checkout, contact, settings, feedback, address, payment details.
---
# Forms — inputs, validation, submit flows

## Structure: Label + Input pairs from the kit, one state object

```tsx
const [form, setForm] = useState({ name: '', email: '' })
const [errors, setErrors] = useState<Record<string, string>>({})
const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setForm(f => ({ ...f, [k]: e.target.value }))

<form onSubmit={submit} noValidate className="flex flex-col gap-4">
  <div className="grid gap-1.5">
    <Label htmlFor="email">Email</Label>
    <Input id="email" type="email" value={form.email} onChange={set('email')} aria-invalid={!!errors.email} />
    {errors.email && <p className="text-sm text-destructive">{errors.email}</p>}
  </div>
  <Button type="submit">Save</Button>
</form>
```

## `noValidate` is not optional

The `<form>` above carries `noValidate` for a reason: with `type="email"` and WITHOUT it, the browser
runs its OWN check first, shows a grey native bubble ("Please include an '@'…"), and your `onSubmit`
never fires — so every message below is dead code and the user hears the browser's voice instead of
your app's. Keep `type="email"` (it still selects the right mobile keyboard) and own the message.

## Validation on submit (not on every keystroke)

```ts
function validate() {
  const e: Record<string, string> = {}
  if (!form.name.trim()) e.name = 'Name is required.'
  if (!/.+@.+\..+/.test(form.email)) e.email = 'Enter a valid email.'
  setErrors(e)
  return Object.keys(e).length === 0
}
const submit = (ev: React.FormEvent) => { ev.preventDefault(); if (!validate()) return; /* act */ }
```

- Per-field messages under the field (pattern above) — never a single generic alert.
- After success: show a confirmation state (swap the form for a message, or reset + show a banner).
- Disable the submit button while a form is knowingly incomplete only for TRIVIAL cases; otherwise
  validate on submit so users aren't mysteriously blocked.
