// restyleTool.ts — the Restyle tool (design-overhaul P5): change an app's whole LOOK mechanically.
//
// Two axes, deliberately distinct:
//   preset — TOKENS (color, radius, type, density). One @import line in src/index.css; instant, total.
//   skin   — STRUCTURE (the block markup itself: a stacked card becomes a row). Certified alternate
//            implementations copied over src/components/blocks from the template's skins/ dir.
//
// This tool is the COMPLEMENT of the frozen-path guard, and the pair is the whole design: the model can
// never hand-edit a block (measured: a 9B rewrote three of them and broke the app), but it CAN swap whole
// certified implementations — the parity checker guarantees every skin block honours the exact base
// interface, so app code renders unchanged under any skin. The freeze is what makes the swap safe; the
// swap is why the freeze costs the model nothing it legitimately needs.
//
// packTool idiom: server-owned content, injected per-session via extraTools, fs writes that bypass the
// model's file tools (and therefore the frozen-path guard — that is not a loophole, it is the point).

import { z } from 'zod'
import type { Tool } from '@cascade/core'
import { activePreset, applySkin, listPresets, listSkins, setPreset } from './templates.js'

const inputSchema = z.object({
	op: z.enum(['preset', 'skin']).describe('preset: swap the design tokens (color/type/radius/density). skin: swap block STRUCTURE (markup).'),
	preset: z.string().optional().describe('op "preset": the preset name, e.g. "luxe-dark". See the tool description for the list.'),
	skin: z.string().optional().describe('op "skin": the skin name, or "base" to restore the stock look.'),
	components: z
		.array(z.string())
		.optional()
		.describe('op "skin" only: swap JUST these blocks (e.g. ["MediaCard"]) and leave the rest as they are. Omit to apply the skin wholesale.'),
})

export interface RestyleToolDeps {
	projectDir: string
	templateId: string
}

/** Build the per-session Restyle tool, or undefined when the project has no theme mechanism to drive. */
export function createRestyleTool(deps: RestyleToolDeps): Tool | undefined {
	const presets = listPresets(deps.projectDir)
	if (presets.length === 0) return undefined // not a themed project (pre-design-system, or not react)
	const skins = listSkins(deps.templateId)
	const skinList = skins.length
		? skins.map((s) => `"${s.id}" (${s.description}; covers ${s.blocks.join(', ')})`).join('; ') + '; "base" restores the stock look'
		: '(none shipped)'

	const tool: Tool<z.infer<typeof inputSchema>> = {
		name: 'Restyle',
		description:
			'Change this app\'s whole look MECHANICALLY — never edit src/themes/, src/index.css\'s @import, or src/components/blocks by hand. ' +
			`Two independent axes. op "preset" swaps the design tokens (colors, fonts, radius, density) — available: ${presets.map((p) => `"${p}"`).join(', ')}. ` +
			`op "skin" swaps the block STRUCTURE (card/nav/hero markup) — available: ${skinList}. ` +
			'They compose: any preset with any skin. App code does not change in either case — blocks keep identical props. ' +
			'Call it when the user asks for a different look/theme/style/vibe; afterwards verify in the browser (the change is visual).',
		inputSchema,
		activitySummary: (input) => (input.op === 'preset' ? `Switching preset to ${input.preset}` : `Applying the ${input.skin} skin`),
		isReadOnly: () => false, // writes src/index.css or block files
		isConcurrencySafe: () => false,

		async call(input) {
			try {
				if (input.op === 'preset') {
					if (!input.preset) return { content: `op "preset" needs a preset name. Available: ${presets.join(', ')}.`, isError: true }
					const change = setPreset(deps.projectDir, input.preset.trim().toLowerCase())
					return {
						content:
							`Preset switched: ${change}. Every token (colors, fonts, radius, shadows, density) now comes from the new preset — no other file changed, nothing to rebuild for dev. ` +
							'Check the result in the browser in LIGHT AND DARK before calling it done.',
					}
				}
				if (!input.skin) return { content: `op "skin" needs a skin name. Available: ${skins.map((s) => s.id).join(', ') || '(none)'}, or "base".`, isError: true }
				const changelog = applySkin(deps.projectDir, deps.templateId, input.skin.trim().toLowerCase(), input.components)
				return {
					content:
						`${changelog} Props are identical by contract, so no app code changes — imports, pages and state all keep working. ` +
						'Verify in the browser; if the user only wanted some surfaces changed, re-run with `components` naming just those blocks.',
				}
			} catch (e) {
				return { content: `Restyle failed: ${e instanceof Error ? e.message : String(e)}`, isError: true }
			}
		},
	}
	return tool
}
