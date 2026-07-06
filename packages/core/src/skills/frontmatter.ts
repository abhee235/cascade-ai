// skills/frontmatter.ts — the tiny shared frontmatter parser behind BOTH engines (skills ADR-055,
// agents ADR-056). A leading `---` block of `key: value` lines; deliberately not YAML — flat string
// values only, tolerant of anything else (a bad skill/agent file must never break a session).

export interface Parsed {
	meta: Record<string, string>
	body: string
}

export function parseFrontmatter(raw: string): Parsed {
	const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
	if (!m) return { meta: {}, body: raw.trim() }
	const meta: Record<string, string> = {}
	for (const line of m[1]!.split('\n')) {
		const kv = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line.trim())
		if (kv) meta[kv[1]!.toLowerCase()] = kv[2]!.trim()
	}
	return { meta, body: raw.slice(m[0].length).trim() }
}
