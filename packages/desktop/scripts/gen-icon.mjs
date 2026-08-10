// gen-icon.mjs — generate the Cascade app icon, from nothing but node.
//
//   node packages/desktop/scripts/gen-icon.mjs
//
// Renders the mark procedurally (no design tool, no asset to lose): a dark rounded-square field with
// three luminous bars stepping down and to the right — water descending a terrace, the literal cascade.
// One 1024px master is rendered with analytic anti-aliasing (signed-distance coverage, ~1px feather),
// then box-resampled to every size each platform wants. Outputs, all into packages/desktop/build/:
//   icon.png   512px  (Linux / BrowserWindow / anything that takes a PNG)
//   icon.ico   16+32+48+64+128+256 as embedded PNGs (Windows: exe + installer)
//   icon.icns  16..1024 as embedded PNGs (macOS bundle)
//
// Everything is written by hand — PNG encoder (zlib + CRC32), ICO directory, ICNS chunks — because the
// formats are trivial containers for PNG data and a devDependency for three small files is not worth it.

import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'build')
const MASTER = 1024

// ── the mark ───────────────────────────────────────────────────────────────────────────────────────────

/** Signed distance to a rounded rectangle centered (cx,cy), half-extents (hw,hh), corner radius r. */
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
	const qx = Math.abs(px - cx) - (hw - r)
	const qy = Math.abs(py - cy) - (hh - r)
	const ax = Math.max(qx, 0)
	const ay = Math.max(qy, 0)
	return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r
}

const cov = (d, feather = 1.25) => Math.min(1, Math.max(0, 0.5 - d / feather))
const lerp = (a, b, t) => a + (b - a) * t

/** The three cascading bars: [x, y, w] at MASTER scale (height/radius shared). */
const BARS = [
	{ x: 170, y: 236, w: 500, c0: [0x67, 0xe8, 0xf9], c1: [0x22, 0xd3, 0xee] }, // cyan
	{ x: 312, y: 446, w: 430, c0: [0x60, 0xa5, 0xfa], c1: [0x3b, 0x82, 0xf6] }, // blue
	{ x: 454, y: 656, w: 360, c0: [0xa5, 0xb4, 0xfc], c1: [0x81, 0x8c, 0xf6] }, // violet
]
const BAR_H = 132
const BAR_R = 66

/** Render the master as RGBA (premultiplied nowhere — straight alpha). */
function renderMaster() {
	const S = MASTER
	const img = new Uint8Array(S * S * 4)
	const margin = 36
	const bgHalf = (S - margin * 2) / 2
	const bgR = 200
	for (let y = 0; y < S; y++) {
		for (let x = 0; x < S; x++) {
			const px = x + 0.5
			const py = y + 0.5
			const aBg = cov(sdRoundRect(px, py, S / 2, S / 2, bgHalf, bgHalf, bgR))
			if (aBg <= 0) continue
			// Field: vertical gradient, deep indigo into near-black — the water at night.
			const t = py / S
			let r = lerp(0x1d, 0x0b, t)
			let g = lerp(0x2a, 0x11, t)
			let b = lerp(0x5e, 0x20, t)
			// Bars, painted over the field with their own soft edges and a left→right lighten.
			for (const bar of BARS) {
				const a = cov(sdRoundRect(px, py, bar.x + bar.w / 2, bar.y + BAR_H / 2, bar.w / 2, BAR_H / 2, BAR_R))
				if (a <= 0) continue
				const u = Math.min(1, Math.max(0, (px - bar.x) / bar.w))
				const br = lerp(bar.c0[0], bar.c1[0], u)
				const bg2 = lerp(bar.c0[1], bar.c1[1], u)
				const bb = lerp(bar.c0[2], bar.c1[2], u)
				r = lerp(r, br, a)
				g = lerp(g, bg2, a)
				b = lerp(b, bb, a)
			}
			const i = (y * S + x) * 4
			img[i] = Math.round(r)
			img[i + 1] = Math.round(g)
			img[i + 2] = Math.round(b)
			img[i + 3] = Math.round(aBg * 255)
		}
	}
	return img
}

/** Area-average resample (handles non-integer ratios — 48px from 1024 included). */
function resample(src, srcS, dstS) {
	const dst = new Uint8Array(dstS * dstS * 4)
	const k = srcS / dstS
	for (let y = 0; y < dstS; y++) {
		const y0 = Math.floor(y * k)
		const y1 = Math.min(srcS, Math.ceil((y + 1) * k))
		for (let x = 0; x < dstS; x++) {
			const x0 = Math.floor(x * k)
			const x1 = Math.min(srcS, Math.ceil((x + 1) * k))
			let r = 0
			let g = 0
			let b = 0
			let a = 0
			let n = 0
			for (let sy = y0; sy < y1; sy++) {
				for (let sx = x0; sx < x1; sx++) {
					const i = (sy * srcS + sx) * 4
					r += src[i]
					g += src[i + 1]
					b += src[i + 2]
					a += src[i + 3]
					n++
				}
			}
			const o = (y * dstS + x) * 4
			dst[o] = Math.round(r / n)
			dst[o + 1] = Math.round(g / n)
			dst[o + 2] = Math.round(b / n)
			dst[o + 3] = Math.round(a / n)
		}
	}
	return dst
}

// ── containers ─────────────────────────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
	const t = new Uint32Array(256)
	for (let n = 0; n < 256; n++) {
		let c = n
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
		t[n] = c >>> 0
	}
	return t
})()
function crc32(buf) {
	let c = 0xffffffff
	for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
	return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
	const len = Buffer.alloc(4)
	len.writeUInt32BE(data.length)
	const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
	const crc = Buffer.alloc(4)
	crc.writeUInt32BE(crc32(body))
	return Buffer.concat([len, body, crc])
}

function encodePng(rgba, size) {
	const ihdr = Buffer.alloc(13)
	ihdr.writeUInt32BE(size, 0)
	ihdr.writeUInt32BE(size, 4)
	ihdr[8] = 8 // bit depth
	ihdr[9] = 6 // RGBA
	// Scanlines with filter byte 0 (None) — deflate does the rest; icons are tiny either way.
	const raw = Buffer.alloc(size * (size * 4 + 1))
	for (let y = 0; y < size; y++) {
		raw[y * (size * 4 + 1)] = 0
		raw.set(rgba.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1)
	}
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk('IHDR', ihdr),
		pngChunk('IDAT', deflateSync(raw, { level: 9 })),
		pngChunk('IEND', Buffer.alloc(0)),
	])
}

/** ICO: a directory of PNG-encoded entries (Vista+ format; 256 is stored as width byte 0). */
function encodeIco(entries) {
	const header = Buffer.alloc(6)
	header.writeUInt16LE(1, 2) // type: icon
	header.writeUInt16LE(entries.length, 4)
	const dirs = []
	const blobs = []
	let offset = 6 + entries.length * 16
	for (const { size, png } of entries) {
		const d = Buffer.alloc(16)
		d[0] = size >= 256 ? 0 : size
		d[1] = size >= 256 ? 0 : size
		d.writeUInt16LE(1, 4) // planes
		d.writeUInt16LE(32, 6) // bpp
		d.writeUInt32LE(png.length, 8)
		d.writeUInt32LE(offset, 12)
		dirs.push(d)
		blobs.push(png)
		offset += png.length
	}
	return Buffer.concat([header, ...dirs, ...blobs])
}

/** ICNS: typed chunks whose payloads are simply PNGs (10.7+). */
const ICNS_TYPES = [
	['icp4', 16],
	['icp5', 32],
	['ic07', 128],
	['ic08', 256],
	['ic09', 512],
	['ic10', 1024],
]
function encodeIcns(pngBySize) {
	const chunks = []
	for (const [type, size] of ICNS_TYPES) {
		const png = pngBySize.get(size)
		const head = Buffer.alloc(8)
		head.write(type, 0, 'ascii')
		head.writeUInt32BE(8 + png.length, 4)
		chunks.push(head, png)
	}
	const body = Buffer.concat(chunks)
	const head = Buffer.alloc(8)
	head.write('icns', 0, 'ascii')
	head.writeUInt32BE(8 + body.length, 4)
	return Buffer.concat([head, body])
}

// ── run ────────────────────────────────────────────────────────────────────────────────────────────────

const master = renderMaster()
const pngBySize = new Map()
for (const size of [16, 32, 48, 64, 128, 256, 512, 1024]) {
	const rgba = size === MASTER ? master : resample(master, MASTER, size)
	pngBySize.set(size, encodePng(rgba, size))
}

mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, 'icon.png'), pngBySize.get(512))
writeFileSync(join(OUT, 'icon.ico'), encodeIco([16, 32, 48, 64, 128, 256].map((size) => ({ size, png: pngBySize.get(size) }))))
writeFileSync(join(OUT, 'icon.icns'), encodeIcns(pngBySize))
for (const f of ['icon.png', 'icon.ico', 'icon.icns']) console.log(`wrote build/${f}`)
