# ADR-089 — The preview says why it failed, at once, and never kills a working server

**Status:** accepted 2026-10-08 (user-approved). **Amends** ADR-081 §4 (host runtime's dev server) and the Browser tool's `open`.
Found by the same v0.1.0 clean-VM run as ADR-088 (`builder-2026-10-07-17-53-12.jsonl`).

## Context — measured 2026-10-07

The last 7.5 minutes of the run were the agent fighting the preview: 8 `Browser {op:"open"}` calls, each
waiting 33–45 s (4.7 min of pure waiting), between three instructions that contradict each other.

- **A launch that dies is not noticed.** `HostSandbox.startDev` spawns `npm.cmd run dev` through a shell,
  writes `dev.json` and returns. With no npm the shell exited within a second (`dev.log`: `'npm.cmd' is not
  recognized`), but the Preview still polled for 60 s and the Browser tool for 30 s, every time.
- **The Browser tool hides the cause and sends the agent the wrong way.** On timeout it says "Run
  `npm run dev` with Bash, check its output" — it never reads `dev.log`, which held the one-line answer. Bash
  then refuses `npm run dev` with "it is already running on the one port this **container** publishes": false
  twice in host mode (no container; nothing was running). The system prompt says Browser starts the server
  itself. The agent bounced between the three.
- **Browser `open` killed the agent's working server.** At 15:43 the agent started Vite itself on the preview
  port; at 15:46 `curl` got HTTP 200. At 15:47 `open` ran its 3-second probe — effectively ONE 2-second
  `fetch('http://localhost:52942')` — which missed, so it called `startDev`, whose `stopDev` found a listener on
  127.0.0.1 whose command line named the project, and `taskkill`ed it. Then `npm.cmd` failed again (45 s). Only
  TIME_WAIT sockets were left on the port afterwards. Likely cause of the miss, not proven: that Vite listened on
  IPv4 `0.0.0.0` only, while `localhost` can resolve to `::1` first; `isListening` probes `127.0.0.1` explicitly.

## Decision

1. **The runtime reports an early exit.** `startDev` keeps the spawned process's exit. `ProjectRuntime` gets an
   optional `devExited(): boolean`. Both waits (PreviewManager's 60 s and Browser's 30 s) stop polling the
   moment it is true and report the error then.
2. **Every failure states the cause from `dev.log`.** The Browser tool's failure text becomes
   "The dev server could not start: <devServerError(log) or the last log lines>" plus the next step that
   actually exists: fix that error (a missing package → `npm install <pkg>`), then `Browser {op:"open"}` again.
   It never tells the agent to run `npm run dev`.
3. **`open` adopts a live server instead of killing it.** Before any restart, `open` asks the same question
   `stopDev` asks — is something listening on the preview port? — on both `127.0.0.1` and `::1`. If yes, it loads
   the page; a restart happens only when nothing is listening. The readiness probe becomes 3 attempts on
   `127.0.0.1` then `localhost`, not one fetch to `localhost`.
4. **The dev-server refusal matches the runtime.** In host and WSL modes it no longer mentions a container or
   claims a server is running; it says the Preview owns the dev server and `Browser {op:"open"}` starts it and
   reports any error. Docker keeps its current text (it is true there).

## Consequences

- A broken toolchain or missing dependency surfaces in about a second with its real message, in the Preview pane
  and to the agent, instead of after 30–60 s with none.
- The agent can no longer lose a working server to the tool that was asked to look at it.
- Verification: on the VM, (a) remove npm from PATH → the Preview shows `npm.cmd is not recognized` within
  ~2 s and Browser `open` returns the same text; (b) a running dev server survives repeated `open` calls.
