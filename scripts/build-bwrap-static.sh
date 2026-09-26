#!/bin/sh
# build-bwrap-static.sh — produce a STATIC bubblewrap binary for the Linux desktop build (ADR-070 Part D).
#
# Upstream ships no static release, and a dynamically linked bwrap breaks across distros (glibc vs musl,
# libcap versions). Building it inside Alpine with -static yields one binary that runs on any x86_64 Linux
# — which is what a bundled resource must do. Run it INSIDE an Alpine environment; from Windows the
# cascade-sandbox WSL distro works (its automount is off, so pipe the script in and copy the result out):
#
#   Get-Content scripts/build-bwrap-static.sh | wsl -d cascade-sandbox --exec /bin/sh -s
#   Copy-Item \\wsl$\cascade-sandbox\out\bwrap packages\desktop\sandbox-bin\linux\bwrap
#
# The fetch script (packages/desktop/scripts/fetch-sandbox.mts) expects the binary at that path; without
# it a Linux build falls back to the host's own bwrap from PATH (most distros ship it for flatpak).
set -eu

BWRAP_VERSION="${BWRAP_VERSION:-0.11.0}"
OUT="${OUT:-/out}"

echo "[bwrap] installing build deps (Alpine)…"
apk add --no-cache build-base meson ninja pkgconf libcap-dev libcap-static linux-headers curl >/dev/null

WORK="$(mktemp -d)"
cd "$WORK"
echo "[bwrap] fetching bubblewrap ${BWRAP_VERSION}…"
curl -fsSL -4 -o bwrap.tar.xz "https://github.com/containers/bubblewrap/releases/download/v${BWRAP_VERSION}/bubblewrap-${BWRAP_VERSION}.tar.xz"
tar -xf bwrap.tar.xz
cd "bubblewrap-${BWRAP_VERSION}"

echo "[bwrap] building static…"
# -static across the board; no man pages, completions, or selinux — a bundled binary needs none of them.
# --prefer-static is load-bearing: without it meson's dependency('libcap') resolves the SHARED libcap.so
# and the -static link fails (measured on the first build) — libcap-static provides the .a it needs.
meson setup _build \
  --buildtype=release \
  --default-library=static \
  --prefer-static \
  -Dc_link_args=-static \
  -Dman=disabled -Dbash_completion=disabled -Dzsh_completion=disabled -Dselinux=disabled -Dpython=python3 \
  >/dev/null
ninja -C _build >/dev/null

mkdir -p "$OUT"
cp _build/bwrap "$OUT/bwrap"
chmod 755 "$OUT/bwrap"
echo "[bwrap] verifying…"
# musl's ldd says "Not a valid dynamic program" for a static binary (glibc's says "statically linked");
# `file` is the unambiguous check, so install it for the verdict. `--version` proves it runs here.
apk add --no-cache file >/dev/null
# Alpine's toolchain emits a static-PIE ("static-pie linked"); older setups say "statically linked". Both are static.
if file "$OUT/bwrap" | grep -qE 'static(ally|-pie) linked'; then echo "[bwrap] static: yes"; else echo "[bwrap] ERROR: not statically linked:"; file "$OUT/bwrap"; exit 1; fi
"$OUT/bwrap" --version
echo "[bwrap] done → $OUT/bwrap"
