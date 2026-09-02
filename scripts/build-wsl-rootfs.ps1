# build-wsl-rootfs.ps1 — produce the cascade-sandbox WSL rootfs tarball (ADR-070 step 5).
#
# What it builds: Alpine minirootfs + node/npm/git/bash/python3 + bubblewrap (the in-VM policy wrap)
# + mise (the toolchain layer, ADR-070 Part B) + the hardened /etc/wsl.conf BAKED IN (automount and
# interop off — a default-configured distro auto-mounts the entire C: drive; the boundary must ship
# in the image, not depend on a post-import step racing first use).
#
# How: import a THROWAWAY build distro (default config, so apk has network and \\wsl$ works for
# copying files in), provision inside, write wsl.conf last, `wsl --export`, unregister. The exported
# tar is what the packaged app bundles and what CASCADE_WSL_ROOTFS points at:
#
#   .\scripts\build-wsl-rootfs.ps1
#   $env:CASCADE_WSL_ROOTFS = "<repo>\dist\wsl\cascade-sandbox-rootfs.tar"
#   $env:CASCADE_RUNTIME = "wsl"
#
# Notes: mise is downloaded on the WINDOWS side and copied in via \\wsl$ — curl inside WSL trips over
# IPv6 DNS on some machines (measured), and the Windows side has no such problem.

param(
	[string]$OutFile = (Join-Path (Split-Path $PSScriptRoot -Parent) 'dist\wsl\cascade-sandbox-rootfs.tar'),
	[string]$BuildDistro = 'cascade-rootfs-build'
)

# 'Continue', NOT 'Stop': under Stop, Windows PowerShell 5.1 turns any native command's STDERR into a
# terminating NativeCommandError — apk's harmless ICU install note killed the whole build (measured).
# Failure detection is explicit $LASTEXITCODE checks instead, which is what actually means "failed".
$ErrorActionPreference = 'Continue'
$env:WSL_UTF8 = '1' # wsl.exe messages are UTF-16LE otherwise — unparseable to every text check below

function Invoke-InBuildDistro([string]$Script) {
	# Merge stderr→stdout INSIDE the distro, so package managers' stderr chatter reaches PowerShell as
	# plain output rather than as error records.
	& wsl.exe -d $BuildDistro --exec /bin/sh -c "( $Script ) 2>&1"
	if ($LASTEXITCODE -ne 0) { throw "in-distro step failed (exit $LASTEXITCODE): $Script" }
}

$work = Join-Path $env:TEMP "cascade-rootfs-$(Get-Random)"
New-Item -ItemType Directory -Force $work | Out-Null

try {
	# 1. Latest Alpine minirootfs (x86_64), resolved from the release manifest — never a hardcoded version.
	Write-Host '[rootfs] Resolving latest Alpine minirootfs...'
	$mirror = 'https://dl-cdn.alpinelinux.org/alpine/latest-stable/releases/x86_64'
	$manifest = [Text.Encoding]::UTF8.GetString((Invoke-WebRequest -UseBasicParsing -ErrorAction Stop "$mirror/latest-releases.yaml").Content)
	$file = ($manifest -split "`n" | Where-Object { $_ -match 'minirootfs.*x86_64\.tar\.gz' } | Select-Object -First 1) -replace '.*:\s*', ''
	if (-not $file) { throw 'could not resolve the Alpine minirootfs filename from latest-releases.yaml' }
	Write-Host "[rootfs] Downloading $file..."
	$alpineTar = Join-Path $work $file
	Invoke-WebRequest -UseBasicParsing -ErrorAction Stop "$mirror/$file" -OutFile $alpineTar

	# 2. Throwaway build distro, DEFAULT config (network + \\wsl$ both needed during provisioning).
	& wsl.exe --unregister $BuildDistro 2>$null | Out-Null # tolerate residue from an aborted build
	Write-Host "[rootfs] Importing build distro '$BuildDistro'..."
	& wsl.exe --import $BuildDistro (Join-Path $work 'distro') $alpineTar --version 2
	if ($LASTEXITCODE -ne 0) { throw "wsl --import failed (exit $LASTEXITCODE)" }

	# 3. Provision: the toolchain a scaffolded project needs on day one + bubblewrap for in-VM policy.
	Write-Host '[rootfs] Installing packages (node, npm, git, bash, python3, bubblewrap)...'
	Invoke-InBuildDistro 'apk add --no-cache nodejs npm git bash python3 bubblewrap ca-certificates'
	Invoke-InBuildDistro 'node --version && npm --version && python3 --version && bwrap --version'

	# 4. mise — downloaded Windows-side, copied in through the build distro's \\wsl$ share.
	Write-Host '[rootfs] Installing mise...'
	$miseLocal = Join-Path $work 'mise'
	# The MUSL build: Alpine has no glibc, and exec-ing a glibc binary fails with a misleading exit 127
	# ("not found" — the ELF interpreter is what's missing, not the file). Measured on the first build.
	Invoke-WebRequest -UseBasicParsing -ErrorAction Stop 'https://mise.jdx.dev/mise-latest-linux-x64-musl' -OutFile $miseLocal
	Copy-Item -ErrorAction Stop $miseLocal "\\wsl$\$BuildDistro\usr\local\bin\mise"
	Invoke-InBuildDistro 'chmod 755 /usr/local/bin/mise && mise --version'

	# 5. The hardened wsl.conf, baked in LAST (writing it earlier would cut off \\wsl$ after a restart).
	Write-Host '[rootfs] Baking hardened wsl.conf (automount off, interop off)...'
	Invoke-InBuildDistro "printf '[automount]\nenabled=false\nmountFsTab=false\n[interop]\nenabled=false\nappendWindowsPath=false\n' > /etc/wsl.conf && cat /etc/wsl.conf"

	# 6. Export + clean up.
	New-Item -ItemType Directory -Force (Split-Path $OutFile -Parent) | Out-Null
	Write-Host "[rootfs] Exporting to $OutFile..."
	& wsl.exe --terminate $BuildDistro 2>$null | Out-Null
	& wsl.exe --export $BuildDistro $OutFile
	if ($LASTEXITCODE -ne 0) { throw "wsl --export failed (exit $LASTEXITCODE)" }

	$mb = [math]::Round((Get-Item $OutFile).Length / 1MB, 1)
	Write-Host "[rootfs] Done: $OutFile ($mb MB)" -ForegroundColor Green
	Write-Host "[rootfs] Use it:  `$env:CASCADE_WSL_ROOTFS = '$OutFile'; `$env:CASCADE_RUNTIME = 'wsl'"
} finally {
	& wsl.exe --unregister $BuildDistro 2>$null | Out-Null
	Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
