// hostTerminal.ts — an interactive shell for HOST mode (ADR-081 §4).
//
// Docker mode gets a real PTY for free: `docker exec -t` allocates one inside the container and dockerode
// streams it, no native code involved. On the host there is no such gift, and the usual answer — node-pty —
// is a NATIVE module. Taking it would reintroduce the per-platform prebuild matrix and the unpack-outside-
// asar problem that the entire storage and packaging design exists to avoid (ADR-081 §1). One terminal is
// not worth that, so this provides the terminal WITHOUT a pty.
//
// What that costs, stated plainly rather than discovered by a confused user (see BANNER below): no
// full-screen programs (vim, top, less), and no interactive prompts, because those need a tty to drive.
// What it does give is what a terminal is opened for nine times out of ten — run a command, watch it
// stream, stop it with Ctrl-C.
//
// The line editing lives here because a piped child never echoes: without local echo you type and see
// nothing at all. `cd` is handled here too — each command is its own process, so a child's chdir would
// die with it and every `cd` would silently do nothing.

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { TerminalHandle } from './terminalSession.js'

const isWindows = process.platform === 'win32'
const CRLF = '\r\n'

/** Said once, at the top of the session — the honest version of "this is not quite a terminal". */
const BANNER = [`\x1b[2mCascade shell — commands run on this machine.\x1b[0m`, `\x1b[2mFull-screen programs (vim, top) and interactive prompts need a real terminal and will not work here.\x1b[0m`, ''].join(CRLF)

/**
 * A shell-like session rooted at `cwd`.
 *
 * Deliberately NOT a persistent shell process with piped stdin: without a tty a shell prints no prompt,
 * echoes nothing, and buffers its output, so the result looks frozen. Running one command per Enter and
 * doing the editing here is less clever and behaves far better.
 */
export function createHostTerminal(cwd: string, onData: (chunk: string) => void, onExit: () => void): TerminalHandle {
	let dir = cwd
	let line = ''
	let child: ChildProcess | undefined
	let dead = false

	const write = (s: string) => {
		if (!dead) onData(s)
	}
	/** Bright-blue directory, then a caret — enough to see where you are without pretending to be bash. */
	const prompt = () => write(`\x1b[34m${dir}\x1b[0m> `)

	write(BANNER)
	prompt()

	const run = (command: string) => {
		// `shell: true` hands the string to cmd.exe or /bin/sh, so pipes, redirects and && behave as typed.
		child = spawn(command, { cwd: dir, shell: true, windowsHide: true, env: { ...process.env, FORCE_COLOR: '1' } })
		const relay = (b: Buffer) => write(String(b).replace(/(?<!\r)\n/g, CRLF)) // xterm needs CRLF, pipes give LF
		child.stdout?.on('data', relay)
		child.stderr?.on('data', relay)
		const finish = (note?: string) => {
			if (!child) return
			child = undefined
			if (note) write(note)
			prompt()
		}
		child.on('error', (e) => finish(`${CRLF}\x1b[31m${e.message}\x1b[0m${CRLF}`))
		child.on('close', (code) => finish(code ? `${CRLF}\x1b[31mexit ${code}\x1b[0m${CRLF}` : CRLF))
	}

	/** `cd` must be interpreted here — a child process's chdir dies with the child. */
	const changeDir = (arg: string): void => {
		const target = !arg || arg === '~' ? cwd : isAbsolute(arg) ? arg : resolve(dir, arg)
		if (existsSync(target) && statSync(target).isDirectory()) dir = target
		else write(`\x1b[31mno such directory: ${arg}\x1b[0m${CRLF}`)
		prompt()
	}

	const submit = () => {
		const command = line.trim()
		line = ''
		write(CRLF)
		if (!command) return prompt()
		if (command === 'exit') {
			write(`exit${CRLF}`)
			dead = true
			return onExit()
		}
		if (command === 'cd' || command.startsWith('cd ')) return changeDir(command.slice(2).trim())
		if (command === 'clear' || command === 'cls') {
			write('\x1b[2J\x1b[H')
			return prompt()
		}
		run(command)
	}

	let prevCh = ''
	return {
		write(data: string) {
			if (dead) return
			for (const ch of data) {
				// A pasted CRLF must submit ONCE: xterm sends the clipboard verbatim, and treating the LF of a
				// CRLF pair as its own Enter ran every pasted line twice (the second an empty prompt at best,
				// a re-executed command at worst).
				if (ch === '\n' && prevCh === '\r') {
					prevCh = ch
					continue
				}
				prevCh = ch
				// Ctrl-C: stop what is running, or just abandon the half-typed line.
				if (ch === '\x03') {
					write('^C' + CRLF)
					if (child) {
						// The shell wrapper spawns the real command as its child, so on Windows only a tree kill
						// actually stops it — SIGINT to the wrapper alone leaves the work running.
						if (isWindows && child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
						else child.kill('SIGINT')
					} else {
						line = ''
						prompt()
					}
					continue
				}
				if (child) continue // keystrokes during a running command are not stdin — there is no tty to feed
				if (ch === '\r' || ch === '\n') {
					submit()
					continue
				}
				if (ch === '\x7f' || ch === '\b') {
					if (line) {
						line = line.slice(0, -1)
						write('\b \b') // erase the character the user sees, not just the buffer
					}
					continue
				}
				if (ch >= ' ') {
					line += ch
					write(ch) // local echo: a piped child never echoes, so without this you type into the void
				}
			}
		},
		// No pty, so nothing to resize. Accepted rather than rejected because the client always sends it.
		resize() {},
		kill() {
			if (dead) return
			dead = true
			if (child?.pid) {
				if (isWindows) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
				else child.kill('SIGKILL')
			}
			child = undefined
			onExit()
		},
	}
}
