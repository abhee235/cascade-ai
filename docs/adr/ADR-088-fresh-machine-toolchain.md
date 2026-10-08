# ADR-088 — A fresh machine builds on first run: the product provisions the toolchain, never the agent

**Status:** accepted 2026-10-08 (user-approved, including decision 6). **Amends** ADR-070 Part D (zero-install sandbox) and ADR-081 §4 (host runtime).
Found by the first clean-VM test of the v0.1.0 desktop release.

## Context — measured 2026-10-07 (VirtualBox Windows 10, nothing installed, gpt-6-luna)

The run (`builder-2026-10-07-17-53-12.jsonl`, "build a chatbot, mock the LLM") took 19m34s. The app's code was
written in about one minute; **about 17 minutes went to the environment**:

- **v0.1.0 ships no Node.** The release workflow never runs `scripts/fetch-sandbox.mts`; `build.mts` only warns
  (`! sandbox: packages/desktop/sandbox-bin/win32 not found`) and packages anyway. `main.ts` then has nothing to
  point `CASCADE_NODE_DIR` / `CASCADE_MISE_PATH` at. The first `npm run build` failed: `'npm' is not recognized`.
- **The agent repaired the machine itself (9.5 min).** It searched install folders, ran
  `winget install OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements` with no
  permission prompt (0 of 88 tool calls asked; winget failed, 0x8A150001), downloaded a Node zip with curl, and
  extracted it with PowerShell `Expand-Archive`, which ran 7 minutes and ended at 0xC000013A, half extracted.
  `tar -xf` then took 8 seconds.
- **Its repair was useless to the product.** The Node landed in `<project>/.tools/`; the Preview spawns
  `npm.cmd` from the app's own PATH, so the Preview never started (`.cascade/dev.log`: `'npm.cmd' is not
  recognized`). That failure is covered by ADR-089 (preview lifecycle).
- **Every fenced command opened a visible console window.** With no bundled `node.exe`, the fence runner is
  hosted by Electron (`fenceHostNode` falls back to `process.execPath`). Electron is a GUI-subsystem binary with
  no console, and `winFence.ts` creates the confined child with `CREATE_UNICODE_ENVIRONMENT` only, so Windows
  gives each `cmd.exe` a new, visible console. The 7-minute `Expand-Archive` ran in one of those windows.
  The fence itself worked: npm's cache and TMP were redirected into `.cascade/tmp`.
- **The prompt hid the facts the agent needed.** The Environment section names the OS and file policy, but not
  the shell (cmd.exe: a fresh machine has no Git Bash), whether node/npm exist, or the preview port. The
  template's AI_RULES.md says "port 5173"; the preview ran on 52942, and the agent curled 5173 twice.
- **mise could not have helped from inside the fence.** mise installs into Cascade's prefix (`MISE_DATA_DIR`),
  which is outside the workspace, so a `mise install` the agent runs is a denied write.

## Decision

1. **Release builds must carry the sandbox.** The release workflow runs `fetch-sandbox.mts` on each OS before
   the build. `build.mts` gets `CASCADE_REQUIRE_SANDBOX=1` (set in CI): missing Node or mise **fails the
   build** instead of warning. A release without its toolchain is a broken release, so it must not package.
2. **The product provisions toolchains, unconfined, before the agent's command runs.** HostSandbox keeps the
   mtime of `mise.toml` it last provisioned. When `exec` sees it changed (the agent added `python = "3.12"`), it
   runs `installProjectToolchains` first, outside the fence (product-owned, like `npm install`). The agent's
   path to a new language is: edit `mise.toml`, run the command.
3. **System package managers are refused in host mode** with the way forward:
   `winget`, `choco`, `scoop`, `msiexec`, `brew`, `apt`/`apt-get`, `dnf`, `pacman` and `sudo`. These change the
   user's machine outside the project, with agreements accepted on the user's behalf. The refusal text says to
   declare the tool in `mise.toml` instead. Docker/WSL runtimes are unaffected (their own disposable OS).
4. **The fenced child never gets a window.** `winFence.ts` sets `STARTF_USESHOWWINDOW` with `SW_HIDE` in the
   child's STARTUPINFO. A child that inherits a console (the bundled `node.exe` host) is unaffected; one that has
   to create its own (the Electron fallback) gets it hidden. Measured 2026-10-08 with an Electron host: the
   v0.1.0 flags open a visible `cmd.exe` window, the new flags open none, and the command runs either way.
   `CREATE_NO_WINDOW` was tried first and rejected: it forces a new console, and a restricted-token child that
   had one to inherit then died with STATUS_DLL_INIT_FAILED (0xC0000142) in the fence tests.
5. **The Environment section states what the agent cannot discover cheaply:** the shell the Bash tool really
   uses (`cmd.exe` or Git Bash), the node/npm versions on the command PATH or "not installed", and, for builder
   sessions, the preview port. AI_RULES.md drops the fixed "port 5173".
6. **Windows ships a bash.** A fresh machine has no Git Bash, so host-mode Bash fell back to cmd.exe. The measured
   9B result (19 of 25 Bash calls failed in cmd, 2026-08-09) says weak models need the dialect their training
   expects. `fetch-sandbox.mts` bundles MinGit's `bash.exe` into `sandbox-bin/win32/git`, `main.ts` points
   `CASCADE_BASH` at it, and `findHostBash` already honours that variable first. Cost: ~45 MB of installer.

## Consequences

- The installer grows by about 130 MB compressed, measured 2026-10-08: Node ~30 MB, mise ~65 MB (a 194 MB
  binary in 2026.10.4) and MinGit ~35 MB. That is the price of a first build that needs no download.
- An agent can no longer install machine-wide software in host mode; that is the intent.
- Verification: a fresh VM install must build a template app with **zero** toolchain commands from the agent,
  no visible console windows, and a Preview that starts (with ADR-089).
