# ADR-090 — "Done" means the main flow was used once in the browser, not only loaded

**Status:** accepted 2026-10-08 (user-approved). **Amends** the builder's definition of done ("Verifying the running app") and the
Browser tool (ADR-060). Found by the v0.1.0 clean-VM run (`builder-2026-10-07-17-53-12.jsonl`).

## Context — measured 2026-10-08

The VM agent built a chatbot whose build was green and whose TemplateAudit was clean. It could not reach the
preview (ADR-088/089), so it shipped unverified. Serving its `dist/` and sending one message:

- **The app crashes on the first message.** `TypeError: o is not a function`, then a blank page. The cause is
  `useEffect(() => transcriptEnd.current?.scrollIntoView({ behavior: 'smooth' }), [messages])`. In Chrome 154,
  `scrollIntoView` returns a **Promise** (checked: `instanceof Promise === true`). The arrow body returns it,
  React stores it as the effect's cleanup, and calls it on the next render. `tsc` cannot see this: lib.dom still
  types `scrollIntoView` as returning `void`.
- **Even a working preview would have passed it.** Done is "build green → TemplateAudit clean → Browser `open`
  loads → Browser `audit` clean". All of that holds on first load; the crash needs one interaction. The Browser
  tool has `click` and `press` but no way to type text, so a chat, a form or a search can never be exercised.

## Decision

1. **Browser gets `op:"type"`:** `{op:"type", target, text, submit?}` fills the input or textarea found by
   label, placeholder or selector (the same lookup as `click`), and presses Enter when `submit` is true.
2. **The definition of done adds one step:** after `audit` on load, use the app's MAIN flow once (send the
   message, add the item, submit the form, start the game) with `type`/`click`/`press`, then `audit` again.
   Console errors or a near-empty page after the interaction mean "not done".
3. **`audit` flags a blank page.** When the body's visible text is near zero, the audit says so ("the page
   rendered nothing: a crash or an empty root") and lists the console errors collected since `open`.
4. **TemplateAudit gets a HARD finding for effects that implicitly return a call:**
   `useEffect(() => something(...))` / `useLayoutEffect(...)` with an expression body that is a call. Fix text:
   wrap the body in braces. An effect may only return a cleanup function, and any call can start returning a value
   (as `scrollIntoView` just did). Concise arrow effects that return nothing (`() => {...}`) are untouched.

## Consequences

- One more Browser round-trip per build. That is cheap next to shipping an app that dies on first use.
- The crash class from the VM build is caught twice: statically (rule 4) and at runtime (rules 2–3).
- Verification: rebuild the chatbot prompt on the VM. The agent must send a message in the browser, and the
  generated code must contain no expression-bodied effect.
