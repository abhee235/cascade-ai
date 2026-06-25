# Learning: MCP init — lazy vs startup, and why we land on background discovery + lazy retry

## Q: Lazy connect (on first use) or connect at startup?
**Background discovery at startup + lazy retry on failure.** Not pure-lazy, not blocking-startup. — ADR-014.

## The fact that decides it: discovery REQUIRES a connection
To let the model *call* an MCP tool you must advertise its `name`/`description`/`inputSchema`. Those come
only from the server's `tools/list` — a runtime call over a **live connection**. The config
(`cascade.mcpServers`) holds the *launch command*, not the tools. So **pure-lazy is chicken-and-egg**: no
connect → no discovery → tool never advertised → model never calls it → "lazy on first call" never fires.

## What the real editors do (research, June 2026)
- **Cursor** — connects to ALL servers at startup, calls `list_tools`, advertises. Config read once (full
  restart to refresh). Disabled servers don't load.
- **Editor B** — (re)starts the server to discover the tools; explicit startup + discovery.
- **Extension C** — `mcpServers` config + a connection timeout on the initial connect; agent-mode only.
- **Extension D** — connects, shows a status panel, caches the tool list; timeout applied at call time.
- **Extension E** — connects to discover; also a read-only editor-level scope; precedence Project > editor > Global.
- **Terminal agent F** — startup connect, with an OPEN feature request to make it lazy/parallel so it doesn't block.
- **CLI agent G** — a filed complaint that lazily loaded MCP tools are missing from the initial tool list;
  users want to **preload** them. (Direct evidence that pure-lazy hides tools.)

**Takeaway:** nobody uses pure-lazy; everyone connects to discover. The two filed pains are (a) startup
connect *blocking* and (b) lazy *hiding* tools. Our design dodges both.

## The decision (ADR-014)
Connect each enabled server in the **background** at startup (non-blocking) → `initialize` + `tools/list` →
advertise once `ready`. A failed server is marked `failed` and **retried lazily** on next turn/use.
State machine: `registered → connecting → ready | failed(retry)`. Tools advertised only when `ready`;
namespace `mcp__server__tool`; builtins win collisions.

- **Background** ⇒ no startup freeze AND no mid-turn connect latency (it happened in parallel while you typed).
- **Retry** ⇒ one bad/slow server never blocks startup or the others.

## Prior art
The common approach connects at startup (blocking-ish), and users have asked for exactly our non-blocking
approach. We adopt background + retry up front. See [[permissions-vs-sandbox]] for the sibling "where it runs decides the policy" theme.
