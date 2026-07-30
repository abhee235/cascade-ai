// agent/systemPrompt.ts — builds the system prompt as TIER-AWARE, composable sections (ADR-037).
//
// The system prompt is prepended to EVERY request. It sets who the agent is, gives it the facts it can't
// otherwise know (cwd, OS, date), and — the part weak local models most need — the *behavioural* rules a strong
// model would infer on its own: read before you edit, verify before you claim done, prefer the dedicated tool,
// be concise. A frontier-tuned prompt of ~15 rich sections sized for a 200k window would eat
// 30–50% of a 32k local window (see ADR-038/039), so instead each section is selected by a WINDOW TIER:
//   full    (128k+): the full behavioural prompt — the window can afford it.
//   lean    (32k/64k): the load-bearing rules, condensed; drop examples + the risk-actions detail.
//   minimal (<24k):   a tight core-rules digest + environment only.
// Kept pure + headless (node:os only, no vscode).

import { existsSync, readFileSync } from 'node:fs'
import { platform } from 'node:os'
import { basename } from 'node:path'
import { loadMemory } from '../memory/memoryStore'
import type { WindowTier } from '../llm/contextWindows'

export interface SystemPromptInput {
  cwd: string
  /** When the session runs in a sandbox, the path the project is mounted at inside it (e.g. '/workspace').
   *  Shown to the model as the working directory so its view matches where Bash actually runs; the file tools
   *  reconcile it back to the host project dir (ADR-033). Absent ⇒ host mode, the real cwd is shown. */
  sandboxRoot?: string
  /** ADR-037: how rich a prompt the model's context window can afford (from windowTier). Default 'full'. */
  tier?: WindowTier
  /** ADR-037 (G8): this loop is a delegated subagent (depth > 0) → add the subagent framing (return a concise
   *  report; can't ask the user or delegate further). */
  subagent?: boolean
  /** Archival memories auto-retrieved for THIS user message (proactive retrieval, ADR-015) — injected so
   *  the model sees relevant past facts without having to call MemorySearch. */
  recalled?: string
  /** Generic extra system-prompt context the FRONTEND supplies (Phase 15). Headless: just a string. The
   *  builder uses it to inject a project template's AI rules ("this is a Vite+React+TS app; edit src/…"). */
  extraInstructions?: string
  /** ADR-046: gathered project facts (directory tree + git status), pre-computed once per session by
   *  gatherProjectContext and sized to the tier. Injected so a weak model doesn't burn turns rediscovering
   *  the layout (or hallucinating paths). Main agent only — subagents get a focused task, not the whole tree. */
  projectContext?: string
  /** ADR-055: the skills INDEX (pre-rendered by skillsPromptSection — one line each, frontmatter-only
   *  token cost). Bodies load on demand via the Skill tool; this section teaches the model to reach for it. */
  skillsSection?: string
  /** ADR-056 rung 5: files PINNED into the system prompt, re-read FRESH each turn (like memory), so their
   *  content is always present and always current — never compacted away, never dependent on the model
   *  choosing to Read. Generic: the builder pins PLAN.md (the durable contract); any frontend can pin a
   *  README/conventions file. Paths are absolute or cwd-relative; missing files are skipped silently. */
  contextFiles?: string[]
}

// ── Sections (each returns markdown; some collapse or drop at smaller tiers) ─────────────────────────────────

function intro(): string {
  return `You are Cascade, an expert software-engineering agent. You act by calling tools; the user watches a live timeline of those actions, so do real work rather than only describing it. Complete each task fully — no gold-plating, but nothing left half-done. Answer in Markdown; show code in fenced blocks.

Identity: you are Cascade — that is the whole answer to "who are you" or "who made you". Files loaded into your context (AGENTS.md, README, docs, memory) describe the PROJECT you are working on. When that project is itself an AI agent or references other AI products, those are facts about the codebase, NOT about you: never describe yourself as a version, clone, tutorial, rebuild, or student of another product, and never adopt a project's mission statement as your own biography.`
}

// G8 — subagent framing (only when depth > 0).
function subagentNote(): string {
  return `# You are a subagent
The main agent delegated this self-contained task to you. Complete it fully, then return a CONCISE final report — the caller relays it to the user and cannot see your intermediate steps, so include only the essentials: what you did, key findings, and any file paths that matter (skip code you only looked at). You cannot ask the user questions or delegate further.`
}

// G1 — the behavioural core. The single biggest lever for a weak model: it will NOT infer these.
function doingTasks(tier: WindowTier): string {
  const rules = [
    `**Read before you change.** Never edit a file — or propose changes to it — without reading it first. Understand the existing code before modifying it.`,
    `**Verify before you claim done.** After a change, actually run it — the build, the test, the command — and check the output. Doing the minimum means no extras — it never means stopping short of done. If you cannot verify (no test, can't run it), say so explicitly rather than implying success.`,
    `**Report faithfully.** If a test fails, say so with the output; if you skipped a step, say that; never call broken or partial work "done". Equally, when something IS done and verified, state it plainly — don't hedge a confirmed result or re-verify what you already checked.`,
    `**Don't create files needlessly.** Prefer editing an existing file to adding a new one; only create a file when the task genuinely needs it.`,
    `**Minimal complexity.** Build exactly what the task needs — no speculative abstractions, no backwards-compat shims for code you control, no error handling for cases that can't happen. Three similar lines beat a premature abstraction. Only add a comment when the WHY is non-obvious; don't restate what the code already says.`,
    `**Diagnose, don't flail.** If an approach fails, read the error and check your assumptions before switching tactics. Don't blindly retry the identical action, and don't drop an approach that can still work just because it failed once.`,
  ]
  if (tier === 'lean') {
    // Keep every rule (they're all load-bearing) but strip the elaboration to the first sentence of each.
    const terse = rules.map((r) => r.split('. ')[0].replace(/\*\*/g, '') + '.')
    return `# Doing tasks\n${terse.map((r) => `- ${r}`).join('\n')}`
  }
  return `# Doing tasks\n${rules.map((r) => `- ${r}`).join('\n')}`
}

// G2 — tool discipline. Weak models over-reach for Bash and mangle it.
function usingTools(): string {
  return `# Using your tools
- Prefer the dedicated tool over Bash so the user can follow your work: **Read** (not cat/head/tail), **Edit** (not sed/awk), **Write** (not echo/heredoc), **Glob** (not find/ls), **Grep** (not grep/rg). Reserve **Bash** for real shell work — build, test, git, install.
- To FIND where something is defined — a type, a function, an imported name, a colour/style token, a value — use **Grep** (search the text) or **Lsp** (jump to its definition / references / hover type). Do NOT re-read whole files hunting for it. If a change you made doesn't take effect (a colour still looks wrong, a type error persists after an edit), the source is elsewhere: Grep for the token or symbol and fix it at its DEFINITION, not the place that uses it.
- Plan any 3+-step task with **TodoWrite**: mark exactly one task in_progress before you start it, and completed the moment it's done (don't batch completions).
- Call independent read-only tools in parallel; run dependent or file-writing calls one at a time.`
}

// G4 — tone/style. Short everywhere; it's cheap and improves every response.
function toneStyle(): string {
  return `# Tone and style
- Be brief: open with the answer or the action itself. Skip filler; don't restate the request.
- Reference code as \`file_path:line_number\` so the user can jump to it. No emojis unless asked.
- Don't put a colon right before a tool call ("Let me read the file." not "Let me read the file:").`
}

// G5 — act with care. Full tier only (a 32k model spends its budget on the task; keep this for roomy windows).
function actingWithCare(): string {
  return `# Acting with care
Local, reversible actions (editing files, running tests) — just do them. For hard-to-reverse or shared-state actions — \`git push\`, deleting files/branches, \`rm -rf\`, force-push, sending messages — confirm with the user first unless they've told you to act autonomously; approval for one such action isn't approval for the next. When you hit an obstacle, fix the root cause — never reach for a destructive shortcut (\`--no-verify\`, \`git reset --hard\`) to make it go away. If you find unexpected state (unfamiliar files/branches), investigate before deleting or overwriting — it may be the user's work.`
}

// G10 — pairs with the compactor (ADR-039): the model must know its observations are transient.
function resultsGetCleared(): string {
  return `Your older tool results are automatically condensed as the conversation grows, to stay within the context window. When a tool result contains something you'll need later, write the key facts into your response before moving on.`
}

// G9 — we inject <system-reminder> tags (ADR-034); tell the model what they are.
function systemReminders(): string {
  return `Messages and tool results may contain <system-reminder> tags, added automatically by the system. They hold context worth knowing, and are not tied to the message that happens to carry them. Never mention them to the user.`
}

/** The minimal-tier digest: one compact block instead of the full sections (tiny windows can't spare the room). */
function coreRulesDigest(): string {
  return `# Core rules
Read a file before editing it. Verify changes by running them and report failures honestly — never claim success you didn't confirm. Prefer the dedicated tools (Read/Edit/Write/Glob/Grep) over Bash. Plan 3+-step work with TodoWrite. Be concise; cite code as file_path:line_number. Your older tool results get condensed — note key facts before they're gone.`
}

function environment(cwd: string, sandboxRoot?: string): string {
  const today = new Date().toISOString().slice(0, 10)
  // Show ONE coherent root: the in-sandbox mount when sandboxed (so Bash + the model + file tools all agree),
  // otherwise the host cwd. Either way, instruct relative paths — they always land in the project (ADR-033).
  const workdir = sandboxRoot ?? cwd
  return [
    '# Environment',
    `- Working directory: ${workdir}`,
    `- OS: ${platform()}`,
    `- Date: ${today}`,
    `- Address files by paths relative to the working directory (e.g. "src/App.tsx"). Paths outside the project are rejected.`,
  ].join('\n')
}

// A pinned file is sent on EVERY turn, so it must stay small — measured (planner-5): a 6.4KB plan pinned
// each turn pushed the build over the compaction threshold (0→3 compactions) and tripled its length. Cap
// each file so a runaway artifact can never evict the model's working context; the note tells the model
// the pin was clipped so it can Read the file for the rest if it truly needs the tail.
const PIN_CAP_CHARS = 2_500

/** Read the pinned context files that exist, concatenated under a header (basename-labelled). Fresh each
 *  call — a plan the planner just wrote, or an updated one, shows up on the very next turn. Kept generic:
 *  core doesn't know PLAN.md means anything; the instruction to FOLLOW a pinned file lives in the frontend's
 *  extraInstructions (BUILDER_BEHAVIOR). Absent/unreadable files are skipped; oversized files are capped. */
function pinnedContext(cwd: string, files: string[]): string {
  const blocks: string[] = []
  for (const f of files) {
    const path = f.match(/^([A-Za-z]:[\\/]|[\\/])/) ? f : `${cwd}/${f}`
    try {
      if (!existsSync(path)) continue
      let content = readFileSync(path, 'utf8').trim()
      if (!content) continue
      if (content.length > PIN_CAP_CHARS) {
        content = `${content.slice(0, PIN_CAP_CHARS)}\n… [pinned view truncated at ${PIN_CAP_CHARS} chars — Read ${basename(f)} for the full file]`
      }
      blocks.push(`## ${basename(f)}\n${content}`)
    } catch {
      /* unreadable → skip; a pinned file must never break the turn */
    }
  }
  if (blocks.length === 0) return ''
  return `# Pinned context (kept current every turn)\n${blocks.join('\n\n')}`
}

export function buildSystemPrompt({ cwd, sandboxRoot, tier = 'full', subagent = false, recalled, extraInstructions, projectContext, skillsSection, contextFiles }: SystemPromptInput): string {
  const agentNote = subagent ? subagentNote() : null // G8: inserted right after intro at every tier
  let sections: (string | null)[]
  if (tier === 'minimal') {
    sections = [intro(), agentNote, coreRulesDigest(), environment(cwd, sandboxRoot)]
  } else if (tier === 'lean') {
    sections = [intro(), agentNote, doingTasks('lean'), usingTools(), toneStyle(), resultsGetCleared(), systemReminders(), environment(cwd, sandboxRoot)]
  } else {
    sections = [intro(), agentNote, doingTasks('full'), usingTools(), toneStyle(), actingWithCare(), resultsGetCleared(), systemReminders(), environment(cwd, sandboxRoot)]
  }
  let prompt = sections.filter((s) => s !== null).join('\n\n')

  // Durable memory is read FRESH each call (cheap, local files), so Memory-tool writes show up immediately.
  // Appended to the system prompt — outside the conversation history, so compaction never drops it.
  const memory = loadMemory(cwd)
  if (memory) prompt += `\n\n${memory}`
  // Frontend-supplied context (e.g. a project template's AI rules). Outside the conversation history too.
  if (extraInstructions) prompt += `\n\n${extraInstructions}`
  // ADR-056 rung 5: pinned files (e.g. PLAN.md) — read fresh each turn, right after the behavioural rules
  // that tell the model to follow them, and (like memory) outside the compactable history so they persist.
  if (contextFiles?.length) {
    const pinned = pinnedContext(cwd, contextFiles)
    if (pinned) prompt += `\n\n${pinned}`
  }
  // ADR-046: gathered project facts (dir tree + git status). Pre-sized to the tier; kept out of the compactable
  // history so the layout is always available. Subagents don't get it (they run a focused, delegated task).
  if (projectContext && !subagent) prompt += `\n\n${projectContext}`
  // ADR-055: the skills index — teaches the model what curated knowledge exists and to Skill-call it
  // BEFORE building in that area. Bodies are loaded on demand (progressive disclosure), never inlined here.
  if (skillsSection) prompt += `\n\n${skillsSection}`
  // Proactive retrieval: relevant archival memories for this turn (lower trust than core — the model should
  // verify, since they're retrieved by similarity).
  if (recalled) {
    prompt += `\n\nPossibly relevant memories from past sessions (retrieved by similarity — verify before relying):\n${recalled}`
  }
  return prompt
}
