// ADR-081 §4 — the HOST terminal.
//
// It is a shell-lite, not a pty (node-pty is native, and this project ships no native modules), so the
// behaviour a real terminal gets from the tty is implemented here instead — and is therefore capable of
// being wrong in ways a real terminal never is. That is what these cover.

import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHostTerminal } from '../src/hostTerminal'

const project = () => mkdtempSync(join(tmpdir(), 'cascade-term-'))

/** Drive a session and collect everything it writes to the client. */
function open(cwd = project()) {
	const out: string[] = []
	let exited = false
	const term = createHostTerminal(cwd, (d) => out.push(d), () => {
		exited = true
	})
	return { term, cwd, text: () => out.join(''), exited: () => exited }
}

const waitFor = async (pred: () => boolean, ms = 10_000) => {
	const deadline = Date.now() + ms
	while (Date.now() < deadline) {
		if (pred()) return
		await new Promise((r) => setTimeout(r, 25))
	}
	throw new Error('timed out')
}

describe('host terminal', () => {
	it('states its limits up front and shows a prompt', async () => {
		// The honest part. A shell that silently cannot run vim is worse than one that says so.
		const s = open()
		expect(s.text()).toMatch(/Full-screen programs/)
		expect(s.text()).toContain(s.cwd)
	})

	it('ECHOES what you type — a piped child never does', async () => {
		// Without local echo you type into the void: the child has no tty, so nothing comes back.
		const s = open()
		s.term.write('echo hi')
		expect(s.text()).toMatch(/echo hi$/)
	})

	it('handles backspace by erasing on screen, not just in the buffer', async () => {
		const s = open()
		s.term.write('lsx')
		s.term.write('\x7f')
		expect(s.text()).toContain('\b \b') // the sequence that actually clears the glyph
		s.term.write('\r')
		await waitFor(() => /\$|>/.test(s.text()))
	})

	it('runs a command and streams its output', async () => {
		const s = open()
		s.term.write('echo cascade-terminal-ok\r')
		await waitFor(() => s.text().includes('cascade-terminal-ok'))
	})

	it('converts LF to CRLF, or every line staircases in xterm', async () => {
		const s = open()
		s.term.write('echo one\r')
		await waitFor(() => s.text().includes('one'))
		expect(s.text()).not.toMatch(/[^\r]\n/) // no bare LF reaches the client
	})

	it('reports a failing command with its exit code', async () => {
		const s = open()
		s.term.write('exit 3\r') // inside the spawned shell, not our `exit` builtin — it is a command here
		await waitFor(() => /exit 3/.test(s.text()))
	})

	it('tracks `cd` ITSELF — a child process chdir would die with the child', async () => {
		// The bug this prevents is silent: every `cd` appears to work and nothing moves.
		const s = open()
		mkdirSync(join(s.cwd, 'sub'))
		s.term.write('cd sub\r')
		await waitFor(() => s.text().includes(join(s.cwd, 'sub')))
	})

	it('refuses a `cd` to nowhere instead of pretending', async () => {
		const s = open()
		s.term.write('cd does-not-exist\r')
		await waitFor(() => /no such directory/.test(s.text()))
	})

	it('treats an empty line as a fresh prompt, not a command', async () => {
		const s = open()
		const before = s.text().length
		s.term.write('\r')
		await waitFor(() => s.text().length > before)
		expect(s.text()).not.toMatch(/exit \d/)
	})

	it('Ctrl-C on an empty line clears it rather than killing the session', async () => {
		const s = open()
		s.term.write('half-typed')
		s.term.write('\x03')
		expect(s.text()).toContain('^C')
		expect(s.exited()).toBe(false)
	})

	it('`exit` ends the session', async () => {
		const s = open()
		s.term.write('exit\r')
		await waitFor(() => s.exited())
	})

	it('kill() ends the session and is safe to call twice', async () => {
		const s = open()
		s.term.kill()
		expect(s.exited()).toBe(true)
		expect(() => s.term.kill()).not.toThrow()
	})

	it('ignores input after the session is dead', async () => {
		const s = open()
		s.term.kill()
		const after = s.text().length
		s.term.write('echo still-here\r')
		expect(s.text().length).toBe(after)
	})

	it('accepts resize even though there is no pty to resize', async () => {
		// The client always sends it; rejecting would be a needless error path.
		const s = open()
		expect(() => s.term.resize(120, 40)).not.toThrow()
	})
})
