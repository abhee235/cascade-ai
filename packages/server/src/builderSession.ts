// builderSession.ts — ONE definition of the builder session and its plan stage (ADR-085 P0, task 1).
//
// The product (projectManager.ts + wsServer.ts) and the Tier-3 bench (scripts/eval/builder.mts) used to build
// these by hand, twice, and they drifted: the 2026-09-27 design A/B ran its template arms without Browser,
// ImageSearch, AI_RULES.md or the product's excluded tools — a bench measuring a builder nobody ships. Both
// now call these functions; the bench may differ only in the fields BenchDifferences names.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ActivityEvent, AgentDef, CascadeSession, McpConnect, McpServerConfig, ModelProvider, Sandbox, SessionOptions, Tracer } from '@cascade/core'
import type { ProjectRuntime } from './projectRuntime.js'
import { browserHostFor, createBrowserTool } from './browserTool.js'
import { createPackTool } from './packTool.js'
import { createTemplateAuditTool } from './auditTool.js'
import { createRestyleTool } from './restyleTool.js'
import { createImageSearchTool } from './imageSearchTool.js'
import { createPlannerSession, ensurePlanPersisted, planQualityIssues, planReviseNudge, planSalvageNudge } from './planStage.js'
import { projectStart } from './templates.js'
import { resourceDir } from './resources.js'

/** Builder behavior injected ahead of every project's AI rules (as generic `extraInstructions`). The core
 *  base prompt is concise-chat-tuned, which makes the model explore then stop; the builder needs the opposite:
 *  keep using tools until the whole app is actually built. Kept here (server/wrapper), not in headless core.
 *  Exported so the Tier-3 builder bench runs sessions IDENTICAL to the product's (forensic fidelity). */
// RECOMPOSED 2026-08-11 (prompt-audit findings B–E): one identity, headed subsections each answering one
// question, precedence declared once at the top, emphasis reserved for the few real invariants (uniform
// shouting reads as uniform priority to a weak model), and every rule keeping its measured origin as a
// comment. Imagery-routing DETAIL moved to the design skill (its trigger words already live there); this
// prompt states only the bar. The audit yardstick: every rule lives in the one section whose question it
// answers, and appears exactly once across system prompt + tool descriptions.
export const BUILDER_BEHAVIOR = [
  '# Builder session',
  'This session has a product role that refines the general rules above — where they conflict, this section wins.',
  '',
  'You are the autonomous app builder for a sandboxed project. The deliverable is working files and a green build; the session is pre-authorized, and no one can answer questions mid-build.',
  '',
  '## Pace',
  '- Complete the entire request this turn: create or edit every file needed, tool call after tool call, until it is fully done. A plan or an explanation is not a deliverable — the working files are.',
  // Measured (gpt-oss:20b, 2026-07-24): ended turns asking permission ("if you'd like me to install…"),
  // cited scope ("beyond what can be done in one turn"), treated `tsc: not found` as a blocker.
  '- Never end your turn to ask a question or offer options ("let me know", "shall I…") — a question burns the turn, because nobody is there to answer. Decide and act.',
  // Batch-3 counterweight (critique): unbounded self-heal licensed `npm install <anything>` while the
  // dashboard skill and most PLANs forbid new deps — the collision resolves here, at the rule itself.
  '- Self-heal instead of stalling: something missing (`tsc: not found`, a package, a directory) is a step to fix — restore what the scaffold declares (`npm install`), create the missing file — and continue. A NEW dependency is different: prefer the kit and existing packages, and add one only when nothing in the kit or the packs can do the job.',
  '- Nothing is "too big for one turn" and nothing gets silently downscoped: decompose and keep building until the whole request is done.',
  '- Length belongs in tool calls, not prose: many file edits, minimal commentary. Never paste file contents into the reply — content goes in the file.',
  '',
  '## Context you already have',
  // Measured (gpt-oss:20b, 2026-07-24): read 24 files across 30 turns and wrote ZERO — analysis-paralysis.
  // Batch-3 scoping (critique): the rule was greenfield-shaped; on later turns the codebase IS the truth.
  '- On a fresh build, do not survey the codebase — the pinned skills and PLAN.md are your context; read a file only right before you edit that exact file, and start writing within your first couple of tool calls. On LATER turns of an existing app, the code is the truth and PLAN.md may be stale: Grep/Read what you are about to change, still without broad surveying.',
  // Same run: tried to READ files its own plan says to CREATE (data.ts 4×), looping on ENOENT.
  '- Files your PLAN lists are targets to create, not files to open: a Read answering "does not exist" means Write it now.',
  '- PLAN.md (pinned below) is the contract: build exactly the views, components, and data model it specifies. The line for updating it first: a NEW view, route, or data-model entity goes through Subagent {agent: "planner", prompt: <the request>} (the pinned copy refreshes automatically); anything smaller you build directly.',
  // Batch-3 (critique, demonstrated by a pinned PLAN that hand-rolled view routing beside useHistoryView):
  // the planner cannot see the scaffold, so PLAN sometimes re-invents an existing seam. The seam wins.
  '- If PLAN.md contradicts an existing seam in src/lib (useHistoryView, storage, photos, utils), the SEAM wins — use it, and note the deviation in one line as you build.',
  // Weak models route poorly on categories — the two always-needed skills are mandated, not routed;
  // situational skills carry literal trigger words in the catalog below.
  '- Before your first Write or Edit, load Skill {name: "architecture"} and Skill {name: "design"} — mandatory. Load the situational skills when their trigger words match.',
  // The plan's `category:` token (design-overhaul P3 slice 5) is the routing instruction, and PLAN.md is
  // pinned into EVERY turn — so unlike an inference made once from the brief, it survives compaction.
  // `game` maps to the `game-dev` skill — the one token whose skill name differs. Stated explicitly:
  // a weak model told "load that category's skill" will otherwise call Skill {name:"game"} and error.
  '- PLAN.md\'s Design line opens with `category: <commerce|dashboard|landing|app-shell|social|game|none>`. Load THAT category\'s skill too (unless it is `none`; `game` loads Skill {name: "game-dev"}): it carries the view contract the plan was written against, plus `reference/pages.md` — the verbatim source of a full, working page of that kind. When a view fights you, read that page rather than inventing a shape.',
  '',
  '## Architecture and quality',
  // Measured (shop-iterate-1): one ever-growing App.tsx crossed the read cap by round 2 — every later
  // edit fought windowed reads and stale views.
  '- Small components: one concern per file under src/components/, every file under ~150 lines — extract as you go, because a file that outgrows the read window makes every later edit blind. New components ARE the deliverable, never clutter: the general "don\'t create files needlessly" rule applies to configs, scripts, and docs, not to the app you were asked to build.',
  // ADR-086 P1: the blocks were frozen and every app wore the same structure (the oracle: themes helped, the
  // structure was the ceiling). They are patterns now; the discipline is tokens, rhythm and the checks.
  '- The app must look designed, not scaffolded: the blocks in src/components/blocks are PATTERNS — use one as it is, edit it in place, or adapt a copy for this subject (keep its data-block stamp) — with token colors only (no raw bg-white/hex), the design skill\'s one spacing rhythm, the app\'s name as a wordmark brand (`<Logo name>`), and real imagery routed per its IMAGERY ROUTING (an emoji is never an image). First impression is part of "done".',
  // ADR-066, measured (gpt-oss:20b): tried `npm run applypack` / `npx @cascade/backend` — mapped the pack
  // to a shell command instead of the provided tool. Say plainly what ApplyPack is.
  '- Persistence is the browser (the src/lib/storage.ts seam) by default. When the user asks for a database, server, or cross-device persistence: load Skill {name: "backend"} and call the ApplyPack tool — it sits in your toolset exactly like Write; it is not a shell command, and hand-writing a server, schema, or migration is never the path.',
  '',
  '## Verifying the running app',
  // Batch-3 (critique): three documents stated "done" at three bars, and the strongest imperative was the
  // weakest bar — a green tsc is fully compatible with a blank page. ONE canonical checklist, stated here.
  // Measured (qwen36-agentic-iq4, builder-shop 2026-08-11): written as a bare name between a backticked
  // SHELL command and a braced TOOL call, "TemplateAudit clean" read as a CLI — the model burned three
  // turns on `npx template-audit`, `npx -y @<some-scope>/template-audit`, `grep -i audit package.json`
  // before finding the tool. Every rung now carries its own call syntax, so the kind is unambiguous.
  '- Done means, in order: `npm run build` green (the declared check) → TemplateAudit {} clean (zero HARD findings — no demo residue, no unreplaced placeholders; it is a TOOL you call, not a shell command) → Browser {op:"open"} loads → Browser {op:"audit"} clean (no invisible content, CSS loaded, no console errors) → USE the main flow once (Browser {op:"type"}/{op:"click"}: send the message, add the item, submit the form, start the game) → Browser {op:"audit"} again: a console error or a blank page after that interaction means the app is broken, not done. Then end the turn.',
  // Batch-3 (critique): "only end when green" + "never ask" had no legal exit when green is impossible —
  // which contradicted "Report faithfully". The honest red is that exit; the gates bound the loop anyway.
  '- If the build still fails after 3 distinct fix attempts on the SAME error, stop: report the exact final error, what you tried, and what was completed. An honest red build is a valid ending; a loop is not.',
  // Batch-4 (subagent-critique): the escalation tier above the inline Browser smoke — situational, because
  // a full second-session QA pass on a local model is minutes of cost; and its report is model output.
  '- When your own checks disagree with reality — audit failing twice on the same problem, or the user saying the app looks wrong — spawn Subagent {agent: "smoketester"} for an independent report. Its findings are claims, not evidence: fix the P0s and re-verify them yourself before calling anything done.',
  // A dev server never exits, so a foreground `npm run dev` blocks until the Bash timeout kills it — no
  // port-readiness signal on that path, unlike the Browser tool (detached start + poll).
  '- To see the app run, use Browser {op:"open"} — it starts the dev server detached and port-polled. A foreground `npm run dev` never returns; it can only stall the turn.',
  // Measured (2026-07-25): `pkill -f vite; pkill -f node` SIGTERMed the container including its own
  // tooling (exit 143), then ~100 turns chasing the empty page it had just caused.
  '- No broad process kills (`pkill -f node`, `pkill -f vite`, `killall`): they take down your own tooling and the dev server, and the blank app you then inspect is a bug you created. The harness reaps stale processes for you.',
].join('\n')

/** A line of BUILDER_BEHAVIOR, by its opening words. The blank start SHARES these rules instead of copying
 *  them, so a fix to one is a fix to both — and a shared line that disappears fails at startup, not silently. */
function sharedRule(prefix: string): string {
  const line = BUILDER_BEHAVIOR.split('\n').find((l) => l.startsWith(prefix))
  if (!line) throw new Error(`BUILDER_BEHAVIOR lost the shared rule "${prefix}"`)
  return line
}

/** ADR-086: the builder role for a project that starts EMPTY (the "None" start). No scaffold, kit, theme,
 *  seams or TemplateAudit — the model picks the stack, scaffolds it and designs freely, with the discipline
 *  carried by tokens and the running-app checks instead of frozen code. BUILDER_BEHAVIOR is untouched. */
export const BUILDER_BEHAVIOR_FREE = [
  '# Builder session — blank start',
  sharedRule('This session has a product role'),
  '',
  'You are the autonomous app builder for a sandboxed project that starts EMPTY: no scaffold, no component kit, no theme. You choose the stack, scaffold it, design it and build it. The deliverable is working files and a green build; the session is pre-authorized, and no one can answer questions mid-build.',
  '',
  '## Pace',
  sharedRule('- Complete the entire request this turn'),
  sharedRule('- Never end your turn to ask a question'),
  '- Self-heal instead of stalling: a missing tool, package or directory is a step to fix — install what package.json declares (`npm install`), create the missing file — and continue. Add a NEW dependency only when the plan or the design needs it, and keep the list short.',
  sharedRule('- Nothing is "too big for one turn"'),
  sharedRule('- Length belongs in tool calls'),
  '',
  '## Context you already have',
  sharedRule('- On a fresh build, do not survey the codebase'),
  sharedRule('- Files your PLAN lists are targets to create'),
  sharedRule('- PLAN.md (pinned below) is the contract'),
  '- Before your first Write or Edit, load Skill {name: "architecture"} and Skill {name: "design"} — mandatory. In a blank project they are the blank-start versions: how to scaffold, and how to design freely with discipline. Load the situational skills when their trigger words match.',
  sharedRule("- PLAN.md's Design line opens with"),
  '- The category skills (commerce, landing, dashboard…) were written for the React template: take their view contract, state shape and acceptance list, and where they name a block or kit piece (NavBar, MediaCard, StatCard, Button…) build your OWN component for that role. There is no `src/components/blocks` or `src/components/ui` here — never import from them.',
  '',
  '## Stack and scaffold',
  '- Default stack: Vite + React + TypeScript + Tailwind CSS v4 — the architecture skill gives the exact files. Another Vite-served stack is fine when PLAN.md names it.',
  '- package.json keeps `"dev": "vite"` and a `build` script that typechecks then runs `vite build`: the preview starts the app with `npm run dev -- --host --port <port>`, and the done check runs `npm run build`.',
  '- Run `npm install` right after writing package.json, before the first build.',
  '',
  '## Design',
  "- The design is yours: PLAN.md's Design line is the direction, the design skill is the method. Every color, font, radius and spacing step is a token in ONE theme file with a light and a dark value; components use the tokens, never raw hex or palette classes.",
  '- If the user attached images, they are the reference: match their palette, type and layout as PLAN.md distilled them.',
  '',
  '## Architecture and quality',
  sharedRule('- Small components: one concern per file'),
  '- Persistence is the browser (localStorage) unless PLAN.md says otherwise. If the app truly needs a server, build it yourself (ApplyPack and the template\'s backend pack do not exist here) and keep `npm run dev` the single entry point that starts everything.',
  '',
  '## Verifying the running app',
  '- Done means, in order: `npm run build` green → Browser {op:"open"} loads → Browser {op:"audit"} clean (no console errors, no content stuck invisible) → use the main flow once with Browser {op:"type"}/{op:"click"}, then audit again → with vision, Browser {op:"screenshot"} of the main views, and fix what looks off.',
  sharedRule('- If the build still fails after 3 distinct fix attempts'),
  sharedRule('- When your own checks disagree with reality'),
  sharedRule('- To see the app run, use Browser {op:"open"}'),
  sharedRule('- No broad process kills'),
].join('\n')

/** The capability dirs every builder-facing session shares: server-owned base first (immutable), then the
 *  project's own `.cascade/` (user-owned; shadows base by name). One definition — builder, plan stage,
 *  and the eval bench must all see the SAME capabilities. A blank-start project (ADR-086) layers the
 *  `builder-free` dirs over the base: their design/architecture/category skills and planner SHADOW the
 *  template-bound ones by name, and the generic ones (backend, forms, data, auth…) are inherited. */
const layers = (kind: 'skills' | 'agents', dir: string) =>
  projectStart(dir) === 'none' ? [resourceDir(kind, 'builder'), resourceDir(kind, 'builder-free')] : [resourceDir(kind, 'builder')]
export const skillDirsFor = (dir: string) => [...layers('skills', dir), join(dir, '.cascade', 'skills')]
export const agentDirsFor = (dir: string) => [...layers('agents', dir), join(dir, '.cascade', 'agents')]

/** The runtime model selection a builder session is built from (ADR-067's active config). */
export interface ActiveModel {
  provider: string
  model: string
  baseUrl?: string
  apiKey?: string
  api?: 'openai' | 'ollama'
  contextWindow?: number
  maxOutputTokens?: number
  temperature?: number
  topP?: number
  topK?: number
  repeatPenalty?: number
  presencePenalty?: number
  thinking?: 'off' | 'low' | 'medium' | 'high'
}

/** Everything a builder session depends on, made explicit (it used to be closed over `this`). */
export interface BuilderSessionDeps {
  dir: string
  provider: ModelProvider
  active: ActiveModel
  tracer: Tracer
  /** Does the model accept images? Gates only Browser op:"screenshot". */
  vision: boolean
  sandbox?: Sandbox
  /** The template's AI rules — appended after BUILDER_BEHAVIOR. */
  extraInstructions?: string
  compactRatio?: number
  mcpServers?: Record<string, McpServerConfig>
  mcpConnect?: McpConnect
}

/** The ONLY fields the bench may set differently from the product (ADR-085): no curation writing into the
 *  user's global memory between runs, and the scenario's turn budget instead of the product's backstop. */
export type BenchDifferences = Partial<Pick<SessionOptions, 'autoMemory' | 'maxTurns'>>

/** The product's builder session options — exactly what ships. The bench passes `differences`. */
export function builderSessionOptions(d: BuilderSessionDeps, differences: BenchDifferences = {}): SessionOptions {
  const { dir, sandbox, extraInstructions } = d
  // ADR-086: the project's start picks the profile. `none` = a blank project: nothing frozen, the free
  // builder role, and the template-bound tools (packs, residue audit, restyle) off — they have nothing to act on.
  const blank = projectStart(dir) === 'none'
  const templateId = blank ? 'none' : 'react'
  const options: SessionOptions = {
    cwd: dir,
    // ADR-086 P1: nothing is frozen, in either start. The blocks were read-only from 2026-08-13 (a 9B had
    // rewritten three of them) until the oracle showed the frozen structure was the ceiling on design; they
    // are patterns now, and the kit is shadcn, editable as shadcn intends. What an edit ADDS is still judged
    // (the design checks and TemplateAudit read edited kit/block files); Restyle never overwrites an edit.
    frozenPaths: [],
    provider: d.provider,
    model: d.active.model,
    // Hosted providers have no live window probe — honor an explicit override so the compactor sizes
    // against the NIM endpoint's real window instead of the model→map guess (or the 8k default).
    contextWindow: d.active.contextWindow,
    // ADR-067: per-model output cap + sampling, applied on every turn (providers ignore what they can't use).
    // UNSET means the window-ratio default ('auto' → max(window/8, 2048) capped at 16,384 — core's
    // recommendedMaxOutputTokens), NOT the flat 16,384 the providers fall back to. On small windows
    // the flat cap let a weak model's thinking eat 40% of the context (measured: 16,384 of 40,960),
    // dragging the wire wall and the compaction trigger down with it. An explicit value still wins.
    maxOutputTokens: d.active.maxOutputTokens ?? ('auto' as const),
    temperature: d.active.temperature,
    topP: d.active.topP,
    topK: d.active.topK,
    repeatPenalty: d.active.repeatPenalty,
    presencePenalty: d.active.presencePenalty,
    thinking: d.active.thinking, // TASK-thinking-control: reasoning-effort knob (rides the sampling plumbing)
    // The autonomous builder has no synchronous user to answer mid-build — drop AskUserQuestion so a
    // weak model can't stall the turn asking permission / for the next step (it must ACT — see
    // BUILDER_BEHAVIOR). Clarifying questions belong to the planner stage, which keeps the tool.
    // ADR-075: drop Lsp too. Its diagnostics half is redundant (type errors are PUSHED after each edit),
    // and its navigation half went UNUSED across the whole build corpus (0 calls) while adding a
    // false-negative hazard — a weak model that fumbles the required line/column gets "no references
    // found" and can act destructively on that false empty. Push diagnostics, don't offer pull-navigation
    // to the weak builder. The LanguageService ENGINE stays (the harness uses it for the diagnostics push).
    excludeTools: ['AskUserQuestion', 'Lsp'],
    // Hardware knob (2026-07-23): earlier compaction keeps decode fast on offloaded setups — see
    // ProjectManagerOptions.compactRatio for the measured rationale.
    compactRatio: d.compactRatio,
    // ADR-071: MCP servers (web search, etc.) the user configured in the MCP panel. The session builds
    // its own McpHub from these and connects in the background; their tools join the registry. Injected
    // (not read from a file here) so a config change + session-invalidation surfaces on the next open.
    mcpServers: d.mcpServers,
    mcpConnect: d.mcpConnect,
    // Product forensics (walkthrough lesson: no trace = no diagnosis). ADR-081: the deployment's own
    // tracer joins the fanout here — on the desktop that is the SQLite store the Observatory reads.
    tracer: d.tracer,
    // ADR-074: ON. The original OFF had two reasons — (a) curation adds hidden model calls (dead air),
    // (b) recall mutated the system-prompt PREFIX, breaking the KV cache. (b) is now gone: dynamic recall
    // appends surfaced facts at the message TAIL (dynamicRecall.ts), leaving the cached prefix intact, and
    // curation writes to archival never touch the frozen system prompt. That leaves only (a) — curation
    // fires just at compaction (bounded dead air), a trade the user chose: a durable fact recalled once
    // beats re-diagnosing it across a dozen fix-loop turns (the measured Velocarta CTA-colour loop).
    autoMemory: true,
    sandbox, // 13.3: command tools run in the project's sandbox when present
    // Sandboxed ⇒ auto-allow (the builder is contained; it shouldn't prompt for every command/edit).
    // Without a sandbox we keep the default gate (the host is not isolated).
    mode: sandbox ? 'bypass' : 'default',
    // Prepend builder behavior to the template's AI rules. The core base prompt is tuned for concise
    // chat ("short, direct responses"), which makes the model stop after exploring; the builder must
    // instead keep using tools u ntil the whole app is built. This OVERRIDES the concise default.
    extraInstructions: [blank ? BUILDER_BEHAVIOR_FREE : BUILDER_BEHAVIOR, extraInstructions].filter(Boolean).join('\n\n'),
    // A full build is many model round-trips (one per file batch); the chat default of 10 is far too low.
    // 80 → 500 (2026-07-20): run 4 hit the 80 cap mid-fix-loop with ~30 turns lost to friction the
    // harness has since fixed — the cap is a runaway BACKSTOP, not a working budget, so it must sit
    // far above any legitimate build. The gates (todo/verify/read-loop) are what end a stuck session.
    maxTurns: 500,
    // ADR-036 SAFETY: the project dir is MODEL-WRITABLE, but hook commands spawn on the HOST — never
    // load a hooks.json the builder itself could have written (sandbox escape at the next open()).
    loadProjectHooks: false,
    // ADR-051: a builder project is "done" when it compiles — declare it, so the verify gate holds the
    // model to `npm run build` by name instead of accepting "I created all the files" on faith.
    checkCommand: 'npm run build',
    // ADR-055: base skills are SERVER-owned (immutable — outside the project and the Read jail);
    // user skills in the project shadow base by name and are theirs to edit.
    skillDirs: skillDirsFor(dir),
    // ADR-056: named agents — base personas server-owned; user personas in the project shadow by name.
    // ADR-056 rung 2 activation is NOT wired here: the base planner.md declares `proactive: true`
    // in its own frontmatter (the idiom: policy travels with the capability, never a session flag).
    agentDirs: agentDirsFor(dir),
    // ADR-056 rung 5: PLAN.md is pinned into the builder's system prompt, re-read each turn — the
    // contract is ALWAYS in context (measured: the builder read it 0 times when only on disk), and
    // survives compaction across iterate rounds (the whole reason a durable plan exists).
    contextFiles: [join(dir, 'PLAN.md')],
    // Server-owned EXTRA tools, each self-gating:
    // - Browser (ADR-060): the agent LOOKS at the app — needs model `vision` + a Docker sandbox.
    // - ApplyPack (ADR-066): graduate the prototype to a backend — offered only while the template
    //   has an UN-applied pack (createPackTool returns undefined otherwise, e.g. after graduation).
    //   templateId follows the project's start (ADR-086): 'react' for the React template, 'none' for a
    //   blank project — which has no packs, no residue contract and no presets, so all three stay off.
    // - ImageSearch (ADR-071): real stock photos for the app — server-side because it's coupled to the
    //   preview CSP img-src allowlist. Always offered (no gating; it degrades to webPhoto/ArtImage).
    extraTools: [
      // Browser rides on BOTH runtimes now (browserHostFor adapts host-mode previewPort/startDev),
      // and vision no longer gates the TOOL — only op:"screenshot" (2026-08-10: a text-only local
      // quant had no runtime smoke channel at all; snapshot/audit/probe are text and stay).
      ...((): import('@cascade/core').Tool[] => {
        const host = browserHostFor(sandbox as unknown as import('./projectRuntime.js').ProjectRuntime | undefined)
        return host ? [createBrowserTool({ sandbox: host, vision: d.vision })] : []
      })(),
      createImageSearchTool(),
      ...([
        createPackTool({ projectDir: dir, templateId }),
        // P1: the residue audit — self-gates to undefined when the template ships no contract.
        createTemplateAuditTool({ projectDir: dir, templateId }),
        // P5: mechanical restyle (preset/skin swap) — self-gates when the project has no themes.
        // The complement of frozenPaths above: blocks can't be hand-edited, only swapped whole.
        createRestyleTool({ projectDir: dir, templateId }),
      ].filter(Boolean) as import('@cascade/core').Tool[]),
    ],
  }
  return { ...options, ...differences }
}

/** The plan-stage session, configured once for product and bench: the builder's model, window and output
 *  cap, the project's skills, and its sandbox (the bench used to omit the sandbox and the 'auto' cap). */
export function plannerSessionFor(
  def: AgentDef,
  d: { dir: string; provider: ModelProvider; active: ActiveModel; sandbox?: Sandbox; tracer?: Tracer },
): CascadeSession {
  return createPlannerSession(def, {
    dir: d.dir,
    provider: d.provider,
    model: d.active.model,
    // The window matters as much as the model: unset, a local backend silently front-truncates the prompt
    // (ADR-038) — so the planner sizes against the same window the builder uses.
    contextWindow: d.active.contextWindow,
    maxOutputTokens: d.active.maxOutputTokens ?? ('auto' as const),
    skillDirs: skillDirsFor(d.dir),
    sandbox: d.sandbox,
    tracer: d.tracer,
  })
}

/** How a caller sees a turn: the product relays events to the UI (a human answers questions and approves);
 *  the bench auto-answers them. Status lines are the product's "Planning…/Installing…" banners. */
export interface TurnHooks {
  onEvent: (ev: ActivityEvent) => void
  onStatus?: (text: string) => void
}
/** A plan stage also needs to know, between rounds, whether it was cancelled (user) or timed out (bench). */
export interface StageHooks extends TurnHooks {
  aborted: () => boolean
}

/** ADR-056 rung 3: run the planner until PLAN.md is on disk, then dispose it. At most ONE extra round:
 *  a SALVAGE when the stage ended with no plan (measured: a 9B spoke its clarifying questions as prose and
 *  stopped), otherwise a REVISE when the plan fails planQualityIssues (over the pin cap, no Design section,
 *  banned imagery). A flawed contract still beats no contract, so the stage never loops. The planner's own
 *  turnDone is swallowed: to the user it is one turn.
 *  ADR-086: the first message's IMAGES go to the planner's first round, so a design reference is studied
 *  before a line of the plan is written (the caller passes them only to a model with vision); the plan is
 *  judged by the rules of the project's start (a blank project has no presets or blocks to name). */
export async function runPlanStage(dir: string, planner: CascadeSession, prompt: string, hooks: StageHooks, images?: Parameters<CascadeSession['submit']>[1]): Promise<void> {
  const round = async (text: string, attach?: typeof images) => {
    for await (const ev of planner.submit(text, attach)) if (ev.type !== 'turnDone') hooks.onEvent(ev)
  }
  const start = projectStart(dir)
  try {
    await round(prompt, images)
    if (!hooks.aborted() && !ensurePlanPersisted(dir, planner)) {
      await round(planSalvageNudge(planner))
    } else if (!hooks.aborted()) {
      const issues = planQualityIssues(readFileSync(join(dir, 'PLAN.md'), 'utf8'), start)
      if (issues.length) {
        hooks.onStatus?.('Tightening the plan…')
        await round(planReviseNudge(issues, start))
      }
    }
  } finally {
    ensurePlanPersisted(dir, planner) // guarantee PLAN.md — from the write, or the planner's final message
    await planner.dispose().catch(() => {})
  }
}

/** One builder turn. Fresh projects ship an EMPTY node_modules, so the agent's first `npm run build` would
 *  hit `tsc: not found` and a weak model stalls asking to install (measured: gpt-oss:20b) — install once,
 *  first. The bench's workdirs share a pre-installed tree and pass no runtime. ADR-085 P2 adds the post-turn
 *  design check here, so the product and the bench get it from the same place. */
export async function runBuilderTurn(
  session: CascadeSession,
  text: string,
  hooks: TurnHooks,
  opts: { images?: Parameters<CascadeSession['submit']>[1]; runtime?: Pick<ProjectRuntime, 'hasDependencies' | 'installDependencies'>; dir?: string } = {},
): Promise<void> {
  const rt = opts.runtime
  // A blank ("None") project has no package.json until the model writes one — nothing is declared, so there is
  // nothing to install, and `npm install` + toolchain provisioning in an empty folder only delays every turn
  // (review, 2026-10-04). The model installs right after writing package.json (the None skill says so).
  const nothingDeclared = opts.dir !== undefined && !existsSync(join(opts.dir, 'package.json'))
  if (rt && !nothingDeclared && !(await rt.hasDependencies().catch(() => true))) {
    hooks.onStatus?.('Installing dependencies…')
    await rt.installDependencies().catch(() => false)
  }
  for await (const ev of session.submit(text, opts.images)) hooks.onEvent(ev)
}
