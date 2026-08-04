// Terminal output → readable text. Measured (2026-07-30): a vite start rendered in the tool card as
// `␛[32m␛[1mVITE␛[22m v8.2.0␛[39m` (a webview has no terminal emulator) and the same escapes were spent
// as model context.

import { describe, expect, it } from 'vitest'
import { cleanTerminalOutput, collapseCarriageReturns, stripAnsi } from '../src/utils/ansi'

const ESC = String.fromCharCode(27)

describe('stripAnsi', () => {
	it('strips SGR colour codes — the exact vite banner from the incident', () => {
		const raw = `${ESC}[32m${ESC}[1mVITE${ESC}[22m v8.2.0${ESC}[39m  ${ESC}[2mready in ${ESC}[0m${ESC}[1m320${ESC}[22m${ESC}[2m ms${ESC}[22m`
		expect(stripAnsi(raw)).toBe('VITE v8.2.0  ready in 320 ms')
	})

	it('strips cursor moves, erases, OSC titles/hyperlinks', () => {
		expect(stripAnsi(`${ESC}[2K${ESC}[1Gprogress`)).toBe('progress')
		expect(stripAnsi(`${ESC}]0;window title${String.fromCharCode(7)}done`)).toBe('done')
		expect(stripAnsi(`${ESC}]8;;https://x${String.fromCharCode(7)}link`)).toBe('link')
	})

	it('leaves ordinary text (including brackets and paths) untouched', () => {
		const plain = 'src/App.tsx:12:3 - error TS2304: Cannot find name [x]'
		expect(stripAnsi(plain)).toBe(plain)
	})
})

describe('collapseCarriageReturns — a redrawn line shows only its final frame', () => {
	it('keeps the last frame of a spinner/progress line', () => {
		expect(collapseCarriageReturns('⠋ install\r⠙ install\r⠹ install\rdone in 3s')).toBe('done in 3s')
	})
	it('preserves genuine multi-line output', () => {
		expect(collapseCarriageReturns('one\ntwo\nthree')).toBe('one\ntwo\nthree')
	})
	it('handles CRLF without eating the line', () => {
		expect(collapseCarriageReturns('a\r\nb')).toBe('a\nb')
	})
})

describe('cleanTerminalOutput', () => {
	it('applies both, in the order a terminal would', () => {
		const raw = `${ESC}[2K⠋ building\r${ESC}[32m✓ built in 3.80s${ESC}[39m`
		expect(cleanTerminalOutput(raw)).toBe('✓ built in 3.80s')
	})
})
