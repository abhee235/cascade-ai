// agent/agentDefs.ts — named agents (ADR-056): file-defined PERSONAS for delegation. Skills change how
// the current agent works; agents change WHO does the work — the frontmatter declares the contract
// (when to use, allowed tools, turn budget, skills to preload) and the markdown body becomes the spawned
// agent's OWN system prompt. v1-small: no per-agent models, no plugins, no agent memory; `interactive`
// parsed but inert until the session's stream-merge lands.

import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { parseFrontmatter } from '../skills/frontmatter'
import type { Skill } from '../skills/skills'

export interface AgentDef {
	name: string
	/** The when-to-use line advertised to the MAIN model (drives the delegation decision). */
	description: string
	/** Tool allowlist for the child registry. Empty/absent ⇒ the standard subagent set. */
	tools?: string[]
	maxTurns?: number
	/** Skill names whose BODIES are preloaded into the child's system prompt (born knowing the recipes). */
	skills?: string[]
	/** Reserved (v1.1): may surface AskUserQuestion cards from inside a spawn. Parsed, currently inert. */
	interactive?: boolean
	/** The child's system prompt (replaces the parent's extraInstructions — personas don't inherit). */
	body: string
	source: string
}

const list = (v: string | undefined): string[] | undefined =>
	v
		? v
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean)
		: undefined

/** Load agent definitions from dirs IN ORDER — later dirs shadow earlier by name (user over base). */
export function loadAgentDefs(dirs: string[]): AgentDef[] {
	const byName = new Map<string, AgentDef>()
	for (const dir of dirs) {
		let files: string[]
		try {
			files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md'))
		} catch {
			continue
		}
		for (const f of files.sort()) {
			try {
				const raw = readFileSync(join(dir, f), 'utf8')
				const { meta, body } = parseFrontmatter(raw)
				const name = meta.name || basename(f).replace(/\.md$/i, '')
				byName.set(name.toLowerCase(), {
					name,
					description: meta.description || '',
					tools: list(meta.tools),
					maxTurns: meta.maxturns ? Number(meta.maxturns) || undefined : undefined,
					skills: list(meta.skills),
					interactive: meta.interactive === 'true',
					body,
					source: join(dir, f),
				})
			} catch {
				/* unreadable — skip; a bad agent file must never break the session */
			}
		}
	}
	return [...byName.values()]
}

/** The agents index for the system prompt (mirrors the skills index — advertise, never inline). */
export function agentsPromptSection(defs: AgentDef[], tier: 'minimal' | 'lean' | 'full'): string {
	if (defs.length === 0) return ''
	if (tier === 'minimal') {
		return `## Agents\nDelegate with Subagent {agent: "<name>", prompt: …}: ${defs.map((d) => d.name).join(', ')}.`
	}
	const lines = defs.map((d) => `- ${d.name} — ${d.description}`)
	return `## Agents\nSpecialized agents you can delegate to with the Subagent tool ({agent: "<name>", prompt: "<task>"}). Each runs with its own instructions and returns a report:\n${lines.join('\n')}`
}

/** Build the child system-prompt extras for a def: its body + any preloaded skill bodies. */
export function agentChildInstructions(def: AgentDef, skills: Skill[]): string {
	const preloaded = (def.skills ?? [])
		.map((name) => skills.find((s) => s.name.toLowerCase() === name.toLowerCase()))
		.filter((s): s is Skill => !!s)
		.map((s) => `## Skill: ${s.name}\n${s.body}`)
	return [def.body, ...preloaded].join('\n\n')
}
