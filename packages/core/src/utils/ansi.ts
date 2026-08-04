// utils/ansi.ts — make raw terminal output READABLE (and cheap) before it reaches the model or the UI.
//
// Measured (2026-07-30, FocusFlow run): `npx vite` output rendered in the tool card as
// `␛[32m␛[1mVITE␛[22m v8.2.0␛[39m` — the webview has no terminal emulator, so escape bytes show up as
// replacement glyphs. The same junk also goes to the MODEL, where every escape is wasted context and a
// weak model can mistake it for content. Spinners are worse: npm/vite redraw a line with \r dozens of
// times, so an install can accumulate hundreds of overwritten frames the terminal never actually showed.

/** Remove ANSI escape sequences: CSI (colors, cursor moves), OSC (title/hyperlinks), and lone 2-byte escapes. */
export function stripAnsi(s: string): string {
	return s
		.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '') // CSI …  (SGR colors, cursor, erase)
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC … BEL | ST  (window title, hyperlinks)
		.replace(/\x1b[@-Z\\-_]/g, '') // other two-character escapes
}

/** Collapse carriage-return redraws: for a line rewritten in place, keep only what a terminal would end up
 *  showing (the text after the final \r). Turns a 200-frame progress spinner into its last frame. */
export function collapseCarriageReturns(s: string): string {
	return s
		.split('\n')
		.map((line) => {
			// A TRAILING \r is just a CRLF line ending — not a redraw. Dropping it first is essential on
			// Windows, where nearly every line ends CRLF and the naive "keep text after the last \r" rule
			// would delete the whole line (caught by test).
			const l = line.endsWith('\r') ? line.slice(0, -1) : line
			return l.includes('\r') ? l.slice(l.lastIndexOf('\r') + 1) : l
		})
		.join('\n')
}

/** Terminal output → plain text, as a human would see it after the dust settles. */
export function cleanTerminalOutput(s: string): string {
	return collapseCarriageReturns(stripAnsi(s))
}
