# ADR-091 — Installing Cascade behaves like installing an app, on all three OSes

**Status:** accepted 2026-10-09 (user-approved, "do this, and think the same for macOS and Linux").
**Amends** ADR-081 (desktop shell) and the provider-key handling of ADR-076.

## Context — reported 2026-10-09 from the v0.1.0/0.1.1 VM tests

- **Windows: no shortcut, so the setup file became the launcher.** Squirrel installs silently into
  `%LOCALAPPDATA%\cascade\` and then starts the app with `--squirrel-install`; the APP is expected to create
  its Start-menu and desktop shortcuts and exit. `main.ts` ignored those events, so no shortcut was ever
  created and the user re-ran `CascadeSetup.exe` (a full reinstall) to open Cascade.
- **Windows: nothing on screen while it installs.** Squirrel shows a `loadingGif` while unpacking, but only if
  the maker gets one. None was configured; the 400 MB package unpacked with no feedback.
- **Every OS: the API key is gone after each restart.** `setProviderKey` puts a key typed in the app into
  `process.env` only ("keys belong in .env for persistence") — right for a developer, wrong for an app user.
- **macOS:** the zip leaves `Cascade.app` wherever it was unzipped (often Downloads). Nothing offers to move
  it to Applications, and auto-update cannot replace an app that is not there.
- **Linux:** the zip has no desktop entry, so Cascade never appears in the app menu; the packaged window has
  no icon either (`build/icon.png` is not shipped, as `main.ts` already notes).

## Decision

1. **Windows install events.** `main.ts` handles Squirrel's events FIRST, before the single-instance lock or
   the server: `--squirrel-install` / `--squirrel-updated` run `Update.exe --createShortcut=Cascade.exe`
   (Start menu + desktop), `--squirrel-uninstall` runs `--removeShortcut`, `--squirrel-obsolete` just exits.
   Each one quits the app. No new dependency (the logic is ~20 lines).
2. **Windows install feedback.** `gen-icon.mjs` also renders `build/install.gif`: the mark's three bars
   filling in on the dark field, looping. The Squirrel maker gets it as `loadingGif`.
3. **Provider keys persist, encrypted by the OS.** The desktop shell gives the server a secret store before
   loading it, backed by Electron `safeStorage`: DPAPI on Windows, the Keychain on macOS, libsecret/KWallet on
   Linux. Keys live in `<userData>/secrets.json` as encrypted base64, never plain text; on Linux without a
   keyring (`basic_text` backend) a key is NOT written to disk and the app says so. On startup, stored keys
   fill `process.env` only where the environment (or `.env`) has not set one; an explicit environment wins.
   Clearing a key in the app deletes it. Keys still never reach the client (ADR-076 `hasKey`). The web/dev
   server, with no store installed, keeps today's session-only behaviour.
4. **macOS: offer the Applications folder.** On a packaged launch outside `/Applications`, ask once:
   "Move Cascade to Applications?" → `app.moveToApplicationsFolder()`. "Not now" is remembered.
5. **Linux: an app-menu entry and a window icon.** `build/icon.png` ships as an extra resource. On each
   packaged launch the app writes `~/.local/share/applications/cascade.desktop` (`Exec` = the running
   binary, `Icon` = the shipped PNG) when it is missing or points at an old path, so moving the unzipped
   folder still leaves a working menu entry.

## Consequences

- Windows behaves like Slack/Discord-style installers: run the setup once, then use the Start menu or
  desktop shortcut; Settings → Apps uninstalls and removes the shortcuts.
- A key typed once survives restarts and updates, protected by the OS user account. Copying `secrets.json`
  to another account or machine yields nothing readable.
- Verification on each OS: install, close, reopen from the shortcut or menu, and the key is still set.
