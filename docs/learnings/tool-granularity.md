# Learning: tool granularity — few general tools vs many narrow ones

## Q: Should `WordCount` be a built-in tool?
No. Mature coding agents ship a small set of **general** primitives — `Read`, `Glob`, `Grep`, `Bash`, `Edit`,
`Write` (+ agent/task/MCP tools). Word count, file size, head/tail, find-and-count, etc. are just
**`Bash`** commands (`wc -l`, `stat`, `head`). There's no dedicated WordCount/Stat/Head tool.

## The principle
Prefer **a handful of composable tools** over many narrow ones:
- a smaller tool list is cheaper in the prompt and easier for the model to choose among,
- `Bash` (and `Read`/`Grep`/`Glob`) compose to cover almost any specific task,
- narrow tools become redundant the moment a general one (esp. `Bash`) exists.

## What it means for Cascade
Until **Phase 8 adds `Bash`**, narrow read-only tools (`WordCount`, `Stat`, `Head`) are genuinely useful
*and* good for learning the `Tool` contract — so building one now is fine. After `Bash` lands, treat new
narrow tools as optional conveniences, not the default. Lean general.
