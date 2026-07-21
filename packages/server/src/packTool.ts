// packTool.ts — the ApplyPack tool (ADR-066): graduates a prototype to a real backend MECHANICALLY.
//
// Backend/database/auth arrive as a server-owned PACK (templates/react/packs/<id>/), not hand-written
// code — so weak models can't hallucinate the boilerplate. The pack lives outside the project (and the
// Read jail), so only the server can apply it: this tool copies the pack's files in and merges its
// package.json fragment, then tells the model the exact next steps. Injected per-session via `extraTools`
// (like the Browser tool) ONLY when the project's template has an UN-applied pack — after graduation the
// tool disappears (isPackApplied), so it can never double-apply.

import { z } from 'zod'
import type { Tool } from '@cascade/core'
import { applyPack, isPackApplied, listPacks } from './templates.js'

const inputSchema = z.object({
	pack: z.string().describe('The pack to apply. Currently: "backend" (Express + Prisma + SQLite API — graduates the app to a real database).'),
})

export interface PackToolDeps {
	projectDir: string
	templateId: string
}

/** Build the ApplyPack tool for a project, or undefined when there is no un-applied pack to offer. */
export function createPackTool(deps: PackToolDeps): Tool | undefined {
	const available = listPacks(deps.templateId).filter((p) => !isPackApplied(deps.projectDir, p.id))
	if (available.length === 0) return undefined
	const names = available.map((p) => `"${p.id}" (${p.description})`).join('; ')

	const tool: Tool<z.infer<typeof inputSchema>> = {
		name: 'ApplyPack',
		description:
			`Graduate this prototype to a real backend by applying a prepared pack — do NOT hand-write a server, database, or Prisma config. Available: ${names}. ` +
			'Call this ONCE when the user asks to persist data on a server / add a database / build a backend. It copies the server, Prisma schema, seed, and API storage adapter into the project and wires package.json. Then follow the exact steps in the result.',
		inputSchema,
		activitySummary: (input) => `Applying the ${input.pack} pack`,
		isReadOnly: () => false, // writes files into the project
		isConcurrencySafe: () => false,

		async call(input) {
			const match = available.find((p) => p.id === input.pack.trim().toLowerCase())
			if (!match) {
				return { content: `No pack "${input.pack}". Available: ${available.map((p) => p.id).join(', ') || '(none — already applied)'}.`, isError: true }
			}
			try {
				const changelog = applyPack(deps.projectDir, deps.templateId, match.id)
				const next =
					match.id === 'backend'
						? '\n\nNEXT STEPS (do these in order, each with Bash):\n' +
							'1. `npm install` (large timeout, e.g. 240000) — installs express, prisma, etc.\n' +
							'2. Add your model(s) to `prisma/schema.prisma` (match src/lib/types.ts), then `npm run db:migrate`.\n' +
							'3. Add each collection to `RESOURCES` in `server/index.ts` (one line per model) — see server/README-server.md.\n' +
							'4. Wire src/lib/data.ts seeds into `prisma/seed.ts`, then `npm run db:seed`.\n' +
							'5. Point the frontend at the API: in `src/lib/storage.ts` re-export `{ createApiStore as createStore } from "./storage.api"` — views/hooks DO NOT change.\n' +
							'6. `npm run build` to verify, then the dev server runs both processes.'
						: ''
				return { content: changelog + next }
			} catch (e) {
				return { content: `ApplyPack failed: ${e instanceof Error ? e.message : String(e)}`, isError: true }
			}
		},
	}
	return tool as Tool
}
