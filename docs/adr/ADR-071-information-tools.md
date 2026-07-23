# ADR-071 — How the model gets information: WebFetch (built-in), web search via MCP, ImageSearch

Status: accepted (building) · 2026-07-23

## Context

A weak local model's knowledge is frozen at its cutoff and thin. During a build it hits things it can't
answer from weights: an uncovered library's API, a current fact, real content, a subject-accurate image the
bundled pack can't cover. Cascade gave it nothing — no fetch, search, or image tool anywhere.

The first draft of this ADR added `WebSearch` as a core built-in with a keyless-DuckDuckGo/keyed-API
backend. Tracing **two established terminal coding agents** (2026-07-23) — a frontier vendor's CLI (agent
A) and an open-source multi-provider CLI (agent B) — showed that's the wrong shape, and both converged on a
better one:

| | Agent A (frontier vendor CLI) | Agent B (open-source multi-provider CLI) |
|---|---|---|
| **Web search** | the vendor's **server-side** search tool (hosted, reuses main auth, ≤8/turn, US-only) — a local model can't use this | **REMOVED the built-in tool**; search is now **BYO via MCP** (Tavily and other search MCP servers) |
| **WebFetch** | plain HTTP GET (no JS render) → HTML→markdown → **small-model summarization pass** (model reads a digest) | plain fetch → HTML-to-text → **model extraction pass**; real private-IP SSRF guard |
| **Registry** | a preapproved-hosts list (~110 curated doc domains) + `llms.txt` **docs-map-first** flow (fetch the index, pick URLs, fetch those, search only as last resort) | — |
| **Research** | a small-model docs-guide subagent runs the docs-map→fetch flow; web tools also on the main agent | — |

**The lesson, and the user's independent instinct, agree:** open web search is NOT a core hot-path tool.
WebFetch + a curated registry is the workhorse; search is external/optional. Neither incumbent uses a
browser for search or fetch; both do plain HTTP + HTML→markdown. Both offload search execution and
SSRF-safety to a server a local model doesn't have — so Cascade must supply its own SSRF guard and get
search from **MCP**, not a hardcoded backend.

## Decision

### 1. `WebFetch` — a core built-in (kept). Algorithm = best-of-both.

`packages/core/src/tools/builtins/WebFetch.ts`, in `builtinTools`. Universal, model-agnostic.

1. **Plain HTTP GET** — no headless browser (neither incumbent renders JS). A Playwright JS-render fallback
   is a *later opt-in* (Cascade already has host Playwright for the Browser tool), not v1.
2. **Content-negotiate markdown first**: `Accept: text/markdown, text/html;q=0.9, …`. If the server
   returns markdown, use it raw — already ideal. Else convert HTML → **markdown** (both incumbents convert
   rather than flatten — headings/links/lists/code are how a model navigates a page), dropping
   nav/header/footer/aside/script boilerplate. Dependency-free (core is bundled into the extension).
3. **Manual redirects, each hop re-checked by the SSRF guard.** `assertFetchableUrl` refuses
   loopback/private/link-local/ULA/metadata (explicit IP-range blocking — *stronger* than agent A's
   single-label hostname check, on par with agent B's private-IP check). Tracing agent A made it explicit
   that a local model must supply this itself; we do.
4. **Cap** the returned markdown to `ctx.readCapChars` (ADR-052), 15s timeout.

**Deferred, and the single biggest win for a small window: summarize-on-fetch.** Both incumbents run the
fetched page through a *small model* with the user's intent and return a **digest**, so the main model
never eats a 50k-token page. Cascade can't do this yet — `ToolContext` carries no model provider. Adding
one (a small/fast model handle, or the session's own) unlocks it. Tracked as a follow-up because it's an
interface change, not a WebFetch tweak.

### 2. Web search — via **MCP**, not a core built-in (Qwen's model)

`WebSearch` is **removed** from `builtinTools`. Search is provided by connecting an MCP server (Tavily,
SearXNG-MCP, Bailian, …). Rationale: no hardcoded backend or key baked into core; the operator picks the
provider; keyless-scraping fragility is avoided; and **Cascade already has a complete MCP engine in core**
(`mcpHub`, `sdkConnect`, `loadMcpConfig`) — search becomes config, not code we own. The gap is only that
the **web server never wired MCP into its sessions and has no UI to manage servers** — that's §4.

### 3. `ImageSearch` — a server extraTool (built). Unchanged.

`packages/server/src/imageSearchTool.ts`, injected via `extraTools` next to Browser/ApplyPack. Openverse
(keyless, CC-licensed, CDN-allowlisted). App-building-specific and coupled to the preview CSP `img-src`.
The runtime `webPhoto()` helper stays the primary weak-model path for catalogs (one call, no multi-step).

### 4. "Connectors" — MCP integration for the web server + UI (built)

The web app-protocol had **zero** MCP messages and `projectManager` passed **no** MCP to `createSession`
(which already accepts `mcpServers` + `mcpConnect` and exposes statuses). Built:

- **TRANSPORT — HTTP, not stdio (the security decision).** `sdkConnect`'s original stdio transport
  **spawns a subprocess per server** = arbitrary code execution on the host. Fine on a machine the user
  owns (the extension, a local box); a **critical RCE on a HOSTED server** — any user could add
  `{command:"bash",args:["-c","…"]}`. So the primary transport is now **StreamableHTTP**: a connector is a
  remote HTTPS MCP **URL** (+ optional auth header), which Cascade only makes HTTP requests to — no process.
  stdio is **refused unless `CASCADE_ALLOW_STDIO_MCP` is set** (defense-in-depth, for a local/trusted box)
  and is **never offered in the web UI**. Tavily's hosted `https://mcp.tavily.com/mcp/?tavilyApiKey=…` is
  the canonical shape — verified live: connects, exposes `tavily_search`/`extract`/`crawl`/`map`/`research`.
- **Config store (new):** `mcpRegistry.ts` — a global `mcp.json` under `PROJECTS_ROOT/.cascade` (mirrors
  `modelRegistry`), `{ name → McpServerConfig }` (`url`/`headers` for HTTP; `command` for opted-in stdio).
  Global (per install), persisted, hand-editable (portable `{ mcpServers }` shape).
- **Server wiring:** `createSessionFor` passes `mcpServers` (a thunk → current enabled set) + `sdkConnect`;
  `invalidateSessions()` so a config change takes effect on the next open; `mcpStatuses()` aggregates live
  status across open sessions (they share one global config) so the standalone panel shows real status.
- **Secrets:** URL query values (Tavily's key) come back **masked** (`?tavilyApiKey=***`) and header values
  are dropped (only NAMES sent) — a key set from the panel lives server-side, never echoed, exactly like a
  model API key. Verified: the real key never reaches the client.
- **app-protocol:** `McpServerInfo` + `mcpServers` event + `listMcpServers`/`addMcpServer`(url,headers)/
  `removeMcpServer`/`toggleMcpServer`.
- **Web UI:** a **"Connectors" nav item** ("connector" is the user-facing term; MCP is the protocol) → a
  panel with live status (idle/connecting/ready/failed + tool count), enable/disable, remove, and an
  add-connector form (name + HTTPS URL + optional Bearer key) with a Tavily preset.
- **Follow-up:** per-chat connector selection (a composer menu, as hosted chat assistants offer) on top of this registry;
  HTTP transport already done, so it's UI-only.

## Security

- **SSRF:** `WebFetch` explicit IP/CIDR + metadata blocking, per-redirect-hop. `ImageSearch` returns only
  allowlisted CDNs. MCP servers are operator-configured (trusted by definition).
- **Keys:** MCP `env` keys and image/search keys live **server-side only**, never sent to the client — same
  rule as model API keys (ADR-067).
- **CSP `img-src`:** image CDNs must be in the preview CSP (none exists today, so images load; if one is
  added, include the `IMAGE_CDN_ALLOWLIST` hosts).

## Curated registry (follow-up, guidance not code)

Agent A's `llms.txt` docs-map-first flow is the highest-value registry pattern and fits Cascade's
**skills**: a skill carries a curated list of doc URLs (react.dev, tailwindcss.com, …) and instructs the
model to WebFetch those for detail, using MCP search only for the long tail. No new code — a skill plus the
existing WebFetch. This is where the "registry of known sites" idea lands.

## Weak-model ergonomics

Single-call tools (`WebFetch(url)`, `ImageSearch(query)`, and MCP search tools are one call each) — never a
chain the model has to orchestrate. Research that fans out (search + several fetches) is a candidate for a
**docs-research subagent** (like agent A's docs-guide subagent) to keep fetched pages out of the main build
context — but note Cascade subagents inherit the parent model, so delegation buys *context hygiene*, not
intelligence; keep the research shallow for weak models.

## Out of scope

Summarize-on-fetch (needs a ToolContext model — follow-up), HTTP/SSE MCP transport (follow-up), a Playwright
JS-render fetch fallback, the docs-map skill, OpenAI hosted `web_search` (doesn't port), per-domain
robots/rate-limit handling.
