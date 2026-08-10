// skills/skills.ts — the skills engine (ADR-055). Knowledge as retrievable files: the model always sees a
// one-line-per-skill INDEX (cheap), and pays for a skill's BODY only when it calls the Skill tool
// (progressive disclosure). v1-small: no per-skill agent budgets, no plugins, no hooks.
//
// Why a TOOL and not "read this path": (1) the harness serves the content, so BASE skills live outside the
// project and outside the Read jail — truly immutable to users and models (user requirement); (2) an
// explicit tool call is the most reliable action a weak model performs; (3) skill usage becomes visible in
// traces/Phoenix, so "does the model consult skills?" is measurable, not hoped.

import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { z } from 'zod'
import type { Tool } from '../tools/Tool'
import { parseFrontmatter } from './frontmatter'

export interface Skill {
	name: string
	description: string
	whenToUse?: string
	body: string
	/** The file it came from (diagnostics only). */
	source: string
	/** Progressive disclosure INSIDE a skill (official pattern): reference docs bundled in a skill
	 *  DIRECTORY (`<name>/SKILL.md` + e.g. `reference/components.md`), served on demand via
	 *  Skill {name, file} — the body stays a lean table of contents. rel path → abs path. */
	references?: Record<string, string>
}

/** Minimal frontmatter parse: a leading `---` block of `key: value` lines. Tolerant — a file without
 *  frontmatter still becomes a skill (name = filename, description = first heading or line). */
function parseSkillFile(path: string): Skill {
	const raw = readFileSync(path, 'utf8')
	const name = basename(path).replace(/\.md$/i, '')
	const { meta, body } = parseFrontmatter(raw)
	if (Object.keys(meta).length === 0) {
		const firstLine = body.split('\n').find((l) => l.trim().length > 0) ?? ''
		return { name, description: firstLine.replace(/^#+\s*/, '').trim().slice(0, 160), body, source: path }
	}
	return {
		name: meta.name || name,
		description: meta.description || '',
		whenToUse: meta.whentouse || meta.when_to_use || undefined,
		body,
		source: path,
	}
}

/**
 * Load skills from directories IN ORDER — later directories SHADOW earlier ones by name. Pass base
 * (server-owned, immutable) dirs first and user dirs last, so users extend or override behavior without
 * ever touching the base files. Missing/unreadable dirs are silently skipped (a project without a
 * .cascade/skills folder is the normal case).
 */
export function loadSkills(dirs: string[]): Skill[] {
	const byName = new Map<string, Skill>()
	for (const dir of dirs) {
		let entries: import('node:fs').Dirent[]
		try {
			entries = readdirSync(dir, { withFileTypes: true })
		} catch {
			continue // dir absent — fine
		}
		for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
			try {
				if (e.isFile() && e.name.toLowerCase().endsWith('.md') && e.name.toLowerCase() !== 'index.md') {
					const skill = parseSkillFile(join(dir, e.name))
					byName.set(skill.name.toLowerCase(), skill)
				} else if (e.isDirectory()) {
					// Directory skill: <name>/SKILL.md + bundled reference docs (official progressive-disclosure
					// pattern, one level deep). Reference paths are collected relative to the skill dir.
					const skillDir = join(dir, e.name)
					const skill = parseSkillFile(join(skillDir, 'SKILL.md'))
					if (skill.name === 'SKILL') skill.name = e.name // frontmatter-less dir skill → dir name
					const references: Record<string, string> = {}
					for (const sub of readdirSync(skillDir, { recursive: true, withFileTypes: true })) {
						if (!sub.isFile() || !sub.name.toLowerCase().endsWith('.md') || sub.name === 'SKILL.md') continue
						const abs = join(sub.parentPath ?? skillDir, sub.name)
						references[abs.slice(skillDir.length + 1).replace(/\\/g, '/')] = abs
					}
					if (Object.keys(references).length > 0) skill.references = references
					byName.set(skill.name.toLowerCase(), skill)
				}
			} catch {
				/* unreadable file/dir — skip, never break the session over a skill */
			}
		}
	}
	return [...byName.values()]
}

/** The compact index for the system prompt (frontmatter-only token cost). */
export function skillsPromptSection(skills: Skill[], tier: 'minimal' | 'lean' | 'full'): string {
	if (skills.length === 0) return ''
	if (tier === 'minimal') {
		return `## Skills\nCall the Skill tool with a name BEFORE related work: ${skills.map((s) => s.name).join(', ')}.`
	}
	const lines = skills.map((s) => `- ${s.name} — ${s.description}${s.whenToUse ? ` (${s.whenToUse})` : ''}`)
	return `## Skills\nCurated project knowledge. Call the Skill tool with the matching name BEFORE working on a related area — do not guess conventions these skills define. Example call: Skill {name: "${skills[0]!.name}"}\n${lines.join('\n')}`
}

const skillInputSchema = z.object({
	name: z.string().describe('The skill to load, from the Skills list in your instructions.'),
	file: z.string().optional().describe('A reference doc WITHIN the skill (listed at the end of the skill body), e.g. "reference/components.md". Omit for the skill itself.'),
})

/** Build the Skill tool over a loaded set. Read-only, parallel-safe, harness-served content. */
export function createSkillTool(skills: Skill[]): Tool<z.infer<typeof skillInputSchema>> {
	return {
		name: 'Skill',
		// One home per rule (prompt-audit C): the "## Skills" catalog in the system prompt owns the inventory
		// and the load-when routing; this description only says what the tool does. Listing names here too
		// doubled every skill name in every prompt.
		description: `Load a project skill — curated, authoritative instructions for a specific kind of work. The "## Skills" catalog in your system prompt lists each skill and when to load it.`,
		inputSchema: skillInputSchema,
		activitySummary: (input) => `Loading skill "${input.name}"${input.file ? ` (${input.file})` : ''}`,
		isReadOnly: () => true,
		isConcurrencySafe: () => true,
		async call(input) {
			const skill = skills.find((s) => s.name.toLowerCase() === input.name.trim().toLowerCase())
			if (!skill) {
				return {
					content: `No skill named "${input.name}". Available skills: ${skills.map((s) => s.name).join(', ')}. Call Skill again with one of these exact names.`,
					isError: true,
				}
			}
			const refs = Object.keys(skill.references ?? {})
			if (input.file) {
				const key = refs.find((r) => r.toLowerCase() === input.file!.trim().replace(/\\/g, '/').toLowerCase())
				if (!key) {
					return {
						content: refs.length
							? `Skill "${skill.name}" has no reference "${input.file}". Available references: ${refs.join(', ')}.`
							: `Skill "${skill.name}" has no reference docs — call it without \`file\`.`,
						isError: true,
					}
				}
				try {
					return { content: `# Skill: ${skill.name} — ${key}\n\n${readFileSync(skill.references![key]!, 'utf8')}` }
				} catch {
					return { content: `Reference "${key}" could not be read.`, isError: true }
				}
			}
			const footer = refs.length
				? `\n\n---\nReference docs in this skill (load with Skill {name: "${skill.name}", file: "<path>"}): ${refs.join(', ')}`
				: ''
			return { content: `# Skill: ${skill.name}\n\n${skill.body}${footer}` }
		},
	}
}
