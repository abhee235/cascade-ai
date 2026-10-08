// fetch-sandbox.mts — download the zero-install sandbox binaries for one platform (ADR-070 Part D).
//
//   npx tsx packages/desktop/scripts/fetch-sandbox.mts [--platform win32|darwin|linux] [--arch x64|arm64]
//
// Output: packages/desktop/sandbox-bin/<platform>/ (gitignored; build.mts copies it into the app):
//   mise(.exe)        the toolchain manager (Layer B) — static; the -musl build on Linux (Alpine-safe)
//   node/             a portable Node LTS tree (node.exe at its root on Windows, bin/node elsewhere) —
//                     the OFFLINE default so web projects build on first run with no download
//   manifest.json     the resolved versions + verified SHA-256s, so any build is auditable
//
// Integrity: every archive is verified against the project's own published SHASUMS256.txt before it is
// extracted — a corrupt or tampered download fails the fetch, never the user's first build. Versions
// default to "latest LTS" resolved at fetch time and are pinnable via MISE_VERSION / NODE_VERSION so a
// release can be reproduced. Static bwrap for Linux is NOT fetched here (no upstream static release);
// scripts/build-bwrap-static.sh produces it — drop the binary in sandbox-bin/linux/bwrap.

import { createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const flag = (name: string, def: string) => {
	const i = args.indexOf(name)
	return i !== -1 && args[i + 1] ? args[i + 1] : def
}
const platform = flag('--platform', process.platform) as 'win32' | 'darwin' | 'linux'
const arch = flag('--arch', process.arch === 'arm64' ? 'arm64' : 'x64') as 'x64' | 'arm64'
const OUT = join(HERE, '..', 'sandbox-bin', platform)
const WORK = join(tmpdir(), `cascade-fetch-${process.pid}`)
mkdirSync(OUT, { recursive: true })
mkdirSync(WORK, { recursive: true })

const manifest: Record<string, { version: string; file: string; sha256: string }> = {}

async function download(url: string, to: string): Promise<void> {
	const res = await fetch(url, { redirect: 'follow' })
	if (!res.ok) throw new Error(`GET ${url} → ${res.status}`)
	await writeFile(to, Buffer.from(await res.arrayBuffer()))
}

async function text(url: string): Promise<string> {
	const res = await fetch(url, { redirect: 'follow' })
	if (!res.ok) throw new Error(`GET ${url} → ${res.status}`)
	return res.text()
}

async function sha256(file: string): Promise<string> {
	return createHash('sha256').update(await readFile(file)).digest('hex')
}

/** Verify `file` against a SHASUMS256.txt body ("<hash>  <name>" lines); throws on mismatch or absence. */
async function verify(file: string, name: string, shasums: string): Promise<string> {
	const line = shasums.split('\n').find((l) => l.trim().endsWith(name))
	if (!line) throw new Error(`${name} not listed in SHASUMS256.txt — refusing to trust it`)
	const expected = line.trim().split(/\s+/)[0]
	const actual = await sha256(file)
	if (actual !== expected) throw new Error(`SHA-256 mismatch for ${name}: expected ${expected}, got ${actual}`)
	return actual
}

/** Extract any archive (.zip / .tar.gz / .tar.xz) with the system tar — bsdtar on Windows 10+ handles all three. */
function extract(archive: string, dest: string): void {
	mkdirSync(dest, { recursive: true })
	// Windows: System32's bsdtar BY PATH. A bare `tar` can resolve to Git's GNU tar (on PATH on the GitHub runner
	// and most dev machines), which reads `C:\…` as a remote host ("Cannot connect to C: resolve failed").
	const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
	execFileSync(tar, ['-xf', archive, '-C', dest], { stdio: 'inherit' })
}

// ── mise ───────────────────────────────────────────────────────────────────────────────────────────────
async function fetchMise(): Promise<void> {
	const version =
		process.env.MISE_VERSION ??
		((JSON.parse(await text('https://api.github.com/repos/jdx/mise/releases/latest')) as { tag_name: string }).tag_name.replace(/^v/, ''))
	const target = platform === 'win32' ? `windows-${arch}` : platform === 'darwin' ? `macos-${arch}` : `linux-${arch}-musl`
	const ext = platform === 'win32' ? 'zip' : 'tar.gz'
	const name = `mise-v${version}-${target}.${ext}`
	const base = `https://github.com/jdx/mise/releases/download/v${version}`
	console.log(`• mise ${version} (${target})…`)
	const archive = join(WORK, name)
	await download(`${base}/${name}`, archive)
	const sum = await verify(archive, name, await text(`${base}/SHASUMS256.txt`))
	const dest = join(WORK, 'mise')
	extract(archive, dest)
	// Archive layout is mise/bin/mise(.exe); normalize to a single binary at sandbox-bin/<platform>/.
	const bin = platform === 'win32' ? 'mise.exe' : 'mise'
	const found = findFile(dest, bin)
	if (!found) throw new Error(`${bin} not found inside ${name}`)
	cpSync(found, join(OUT, bin))
	if (platform !== 'win32') chmodSync(join(OUT, bin), 0o755)
	manifest.mise = { version, file: name, sha256: sum }
}

// ── node ───────────────────────────────────────────────────────────────────────────────────────────────
async function fetchNode(): Promise<void> {
	const channel = process.env.NODE_VERSION ? `v${process.env.NODE_VERSION.replace(/^v/, '')}` : 'latest-v22.x'
	const base = `https://nodejs.org/dist/${channel}`
	const shasums = await text(`${base}/SHASUMS256.txt`)
	const suffix = platform === 'win32' ? `win-${arch}.zip` : platform === 'darwin' ? `darwin-${arch}.tar.gz` : `linux-${arch}.tar.gz`
	const name = shasums
		.split('\n')
		.map((l) => l.trim().split(/\s+/)[1])
		.find((n) => n && n.endsWith(suffix))
	if (!name) throw new Error(`no ${suffix} asset in ${base}/SHASUMS256.txt`)
	const version = name.match(/node-(v[\d.]+)-/)?.[1] ?? channel
	console.log(`• node ${version} (${suffix})…`)
	const archive = join(WORK, name)
	await download(`${base}/${name}`, archive)
	const sum = await verify(archive, name, shasums)
	const dest = join(WORK, 'node')
	extract(archive, dest)
	// The archive unpacks to node-vX-<target>/; ship that tree as sandbox-bin/<platform>/node/.
	const tree = readdirSync(dest).map((d) => join(dest, d))[0]
	if (!tree) throw new Error(`empty node archive ${name}`)
	rmSync(join(OUT, 'node'), { recursive: true, force: true })
	renameSync(tree, join(OUT, 'node'))
	manifest.node = { version, file: name, sha256: sum }
}

// ── MinGit (Windows only, ADR-088 §6) ──────────────────────────────────────────────────────────────
// A fresh Windows machine has no Git Bash, and host-mode Bash then falls back to cmd.exe, the dialect weak
// models fail in. MinGit is Git for Windows' minimal redistributable: no bash.exe by that NAME, but its
// usr/bin/sh.exe IS bash 5 (arrays, [[ ]]) plus coreutils/grep/sed. main.ts points CASCADE_BASH at it.
// Integrity: GitHub's own per-asset sha256 digest (Git for Windows publishes no SHASUMS file).
async function fetchMinGit(): Promise<void> {
	const tag = process.env.MINGIT_TAG ? `tags/${process.env.MINGIT_TAG}` : 'latest'
	const rel = JSON.parse(await text(`https://api.github.com/repos/git-for-windows/git/releases/${tag}`)) as {
		tag_name: string
		assets: { name: string; digest?: string; browser_download_url: string }[]
	}
	const want = arch === 'arm64' ? /^MinGit-[\d.]+-arm64\.zip$/ : /^MinGit-[\d.]+-64-bit\.zip$/
	const asset = rel.assets.find((a) => want.test(a.name))
	if (!asset) throw new Error(`no MinGit ${arch} asset in git-for-windows ${rel.tag_name}`)
	const expected = asset.digest?.replace(/^sha256:/, '')
	if (!expected) throw new Error(`${asset.name} has no published sha256 digest — refusing to trust it`)
	console.log(`• MinGit ${rel.tag_name} (${asset.name})…`)
	const archive = join(WORK, asset.name)
	await download(asset.browser_download_url, archive)
	const actual = await sha256(archive)
	if (actual !== expected) throw new Error(`SHA-256 mismatch for ${asset.name}: expected ${expected}, got ${actual}`)
	rmSync(join(OUT, 'git'), { recursive: true, force: true })
	extract(archive, join(OUT, 'git'))
	if (!existsSync(join(OUT, 'git', 'usr', 'bin', 'sh.exe'))) throw new Error(`usr/bin/sh.exe not found inside ${asset.name}`)
	manifest.mingit = { version: rel.tag_name, file: asset.name, sha256: actual }
}

function findFile(dir: string, name: string): string | undefined {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, entry.name)
		if (entry.isDirectory()) {
			const hit = findFile(p, name)
			if (hit) return hit
		} else if (entry.name === name) return p
	}
	return undefined
}

try {
	await fetchMise()
	await fetchNode()
	if (platform === 'win32') await fetchMinGit()
	writeFileSync(join(OUT, 'manifest.json'), JSON.stringify({ platform, arch, fetchedAt: new Date().toISOString(), ...manifest }, null, 2))
	console.log(`✓ sandbox binaries ready → ${OUT}`)
	if (platform === 'linux' && !existsSync(join(OUT, 'bwrap'))) {
		console.warn('! linux: no static bwrap in sandbox-bin/linux — build one with scripts/build-bwrap-static.sh (the host bwrap from PATH is used until then)')
	}
} finally {
	rmSync(WORK, { recursive: true, force: true })
}
