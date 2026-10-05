---
name: auth
description: Mock login/signup with localStorage sessions, header account menu, and friendly view guarding. No backend — honestly presented.
whenToUse: Load when the task mentions ANY of: login, log in, sign up, signup, register, account, profile, log out, user session, protected page, only for logged-in users.
---
# Auth (mock) — accounts without a backend

There is NO backend. Auth is a client-side mock that demonstrates the full UX honestly.

```ts
// lib/types.ts
export interface User { email: string; name: string }
// hooks/useAuth.ts — localStorage-backed session
export function useAuth() {
  const [user, setUser] = useLocalStorage<User | null>('auth:user', null)
  const login = (email: string, name: string) => setUser({ email, name })
  const logout = () => setUser(null)
  return { user, login, logout }
}
```

## The pattern

- A `Login` view (forms.md rules) that accepts any well-formed email + non-empty password and calls
  `login()`. Optionally keep a `users` record in localStorage for "sign up then log in" realism.
- Header shows either a "Log in" button or the user's name + a DropdownMenu (Profile, Log out).
- **Guarding**: views that need auth render a friendly gate, not a crash:
  `if (!user) return <LoginPrompt onLogin={() => setView({ kind: 'login' })} />`.
- NEVER pretend it's secure — no fake "encryption", no real-looking API calls. It's a demo pattern.

## The screen — `<AuthCard>`, never a hand-rolled centred div

```tsx
<AuthCard brand={<Logo name="Meridian" />}
  title="Welcome back" subtitle="Sign in to pick up where you left off."
  error={failed ? 'That email and password do not match.' : undefined}
  footer={<>No account? <button type="button" onClick={goSignUp} className="text-foreground underline underline-offset-4">Create one</button></>}>
  <div className="grid gap-1.5"><Label htmlFor="email">Email</Label><Input id="email" type="email" /></div>
  <div className="grid gap-1.5"><Label htmlFor="password">Password</Label><Input id="password" type="password" /></div>
  <Button className="mt-1 w-full">Sign in</Button>
</AuthCard>
```

An auth page has **no NavBar and no Footer** — there is nothing to navigate to until the user is in.
Sign-up, sign-in, and password reset are the SAME block with different fields. For account, settings,
and notification-preference screens, load the `app-shell` skill.
