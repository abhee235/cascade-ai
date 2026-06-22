# Learning: agent architecture — one agent or many?

## Q: Is there one agent, or multiple? Role-based configs or dynamically created?
**Both.** The common design in mature coding agents:

- **One main-thread agent** = the top-level query loop running the user session. Always exactly one.
- **Zero or more subagents** = *independent re-invocations of the same loop*, spawned on demand. A
  subagent is distinguished by having its own `agentId`.

**Agents are static, role-based configurations** (`AgentDefinition`) — each carries its own prompt,
model, tool subset, permissions. Two sources:
- **Built-in**: a general-purpose agent, read-only explore/plan agents, etc. The read-only ones can
  even drop the project-instructions file from their context.
- **Custom from disk**: an agents directory of `*.md` files with YAML frontmatter (`name`,
  `description`, `tools`, `model`, `prompt`…), parsed at startup.

**They're instantiated dynamically at runtime**: the main model emits a **`Task`/`Agent` tool call**
naming a `subagent_type`; the tool looks up that static config and launches a **brand-new `query()`
loop** with its OWN fresh context window, system prompt, model, and tools (`runAgent.ts`).

**Handoff:** the subagent runs to completion in isolation; only its **final message becomes a
`tool_result`** in the parent's loop. Its full transcript never pollutes the parent's context — that
isolation is the whole point (keeps the main conversation small).

There's also an optional, flag-gated **coordinator/swarm** mode (`src/coordinator/`) for multi-worker
teams — off by default, not core.

## Plain verdict
Not "one agent," not "infinite freeform agents" — a **registry of role configurations**, any of which
the main agent can **instantiate on-the-fly as a child loop**.

## How Cascade stages it
- **Phase 4 (now):** only the single main loop (`runAgentLoop`). No subagents.
- **Phase 11:** the subagent mechanism — `AgentDefinition` configs, loading agent `*.md` files from an
  agents directory, a `Subagent` tool that selects a type and spawns a child loop with its own
  context/tools/prompt, and the "last assistant message → tool_result" handoff. Coordinator/swarm stays optional/later.
