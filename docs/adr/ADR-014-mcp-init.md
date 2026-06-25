# ADR-014 — MCP initialization: eager **background** discovery + lazy retry

**Status:** Accepted (Phase 9). **Revises** the original plan ("lazy MCP — connect on first tool use").

## Context
The original divergence said: don't connect MCP servers at startup; connect lazily on first tool use.
While building Phase 9 we hit a hard problem that makes pure-lazy unworkable:

**Discovery requires a connection.** To let the model *call* an MCP tool you must first advertise its
`name` + `description` + `inputSchema`. Those come only from the server's `tools/list` — a runtime call over
a live connection. The config (`cascade.mcpServers`) contains the *launch command*, not the tool list. So
pure-lazy is chicken-and-egg: no connection → no discovery → tool never advertised → model never calls it →
"lazy on first call" never fires.

Research confirms no mainline editor uses pure-lazy, and the two extremes each cause filed bugs:
- **The mainstream editor assistants and agent extensions** all **connect to discover** (`list_tools`) — most
  at startup. (One documents that it restarts the server just to discover the tools.)
- **Startup connect blocking** is a known pain → an issue filed against one terminal agent asks to init
  lazily/parallel.
- **Pure-lazy hiding tools** is a known pain → an issue filed against another CLI agent reports that lazy MCP
  tools are missing from the initial tool list, and users ask to **preload** them.

## Decision
**Connect each enabled server in the BACKGROUND at startup (non-blocking), discover via `tools/list`, and
advertise. If a server fails, mark it failed and RETRY lazily on the next turn / next attempted use.**

Each server walks a small state machine:
```
registered ──connect()──▶ connecting ──tools/list ok──▶ ready   (its tools are advertised)
                               └─────────── error ─────▶ failed  (retry on next turn/use)
```
- **Background** ⇒ the UI never freezes on startup, and the first turn pays no connect latency (it happened in
  parallel while you read/typed). This is the synthesis the communities are asking for.
- **A server's tools are advertised only when `ready`** ⇒ the model only ever sees callable tools.
- **Failure is isolated** ⇒ one bad server never breaks startup or the other servers; it's retried lazily.
- **Namespacing** `mcp__<server>__<tool>`; on a name clash, **builtins win**.

## Consequences
- No mid-turn connect delay (the concern that prompted this) and no startup freeze.
- Resilient: a hung/broken server degrades gracefully (retry), rather than blocking or being invisible.
- Cascade's divergence from the usual startup connect becomes "**background + retry**," not "pure lazy."
- Slightly more lifecycle state (the per-server status) than a naive connect-all — worth it.

## Prior art
Editor assistants commonly connect all servers at startup → `list_tools` → advertise (config read once).
One restarts the server to discover. Another configures `mcpServers` with a `connectionTimeout` on the
initial connect. Terminal agents typically connect at startup, with open requests to make it non-blocking —
which is exactly our background approach.

Sources: the public MCP documentation and issue trackers of several editor assistants and agent CLIs.
