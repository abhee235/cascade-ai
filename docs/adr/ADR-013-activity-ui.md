# ADR-013 — Streamed output + activity view (editor-assistant style)

**Status:** Accepted (Phase 2). **Supersedes an earlier draft** that said "no prose streaming" — that
draft mischaracterized the reference tools and was corrected.

## Context
The user wants the UX of the mainstream editor chat assistants. Verified from their published docs:
those tools **stream the response token-by-token** AND emit progress/tool events alongside the text.
So the target is **both**: live prose **and** a visible activity/tool view.

## Decision
- **Stream prose and thinking token-by-token to the UI.** The provider yields internal `StreamEvent`s;
  the session forwards them as **frontend `ActivityEvent`s** (`text_delta`, `thinking_delta`). The
  webview grows the current assistant bubble live (with a caret); thinking streams live into an
  expanded section.
- **Emit a final `message` ActivityEvent** when the stream ends — the authoritative copy the UI commits
  (replacing the live buffer) and that Phase 3 will store in history.
- **`status` ActivityEvents** carry coarse activity ("Thinking…"); from Phase 4, tool-step activity
  (reading, running, editing) renders as cards. That's the "what it's doing" view *for actions*,
  shown alongside the streamed text — not instead of it.
- The session is still the translation point: provider `StreamEvent` → frontend `ActivityEvent`. The
  frontend only ever renders `ActivityEvent`s (keeps it transport-portable — see `docs/FRONTEND.md`).

## Consequences
- You see tokens appear word-by-word, like the reference tools.
- The final `message` makes the committed transcript authoritative (no drift from accumulated deltas).
- This is **no longer a divergence from the mainstream agents** on display — they all stream prose. Cascade's
  remaining deliberate divergence is **MCP init — background discovery + lazy retry** (ADR-014); naming is a convention, not a divergence.

## Prior art
Terminal agents stream content blocks to their TUI as deltas arrive. Cascade does the same, exposed
through the `ActivityEvent` protocol so any frontend (extension/web/desktop) renders it identically.
