#!/usr/bin/env bash
# Builds the box bundle the installer downloads: salu-box-linux-<arch>.tar.gz (+ .sha256) holding the salu binary,
# the three installer scripts and the kernel Containerfile. The binary must run on this machine (it writes the
# Containerfile), so build the matching architecture on a matching runner, or pass --containerfile FILE.
#
#   scripts/build-box-bundle.sh <salu-binary> <x64|arm64> <out-dir> [--containerfile FILE]
set -euo pipefail
BIN="${1:?salu binary}"; ARCH="${2:?x64 or arm64}"; OUT="${3:?output folder}"; shift 3
CF=""; [ "${1:-}" = --containerfile ] && CF="${2:?file}"
case "$ARCH" in x64|arm64) ;; *) echo "arch must be x64 or arm64" >&2; exit 2 ;; esac
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAME="salu-box-linux-$ARCH"
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
D="$W/$NAME"; mkdir -p "$D/kernel" "$OUT"
install -m 0755 "$BIN" "$D/salu"
for f in install-box.sh install-runner.sh install-kernel-runtime.sh; do install -m 0755 "$HERE/$f" "$D/$f"; done
if [ -n "$CF" ]; then cp "$CF" "$D/kernel/Containerfile"; else "$BIN" kernel containerfile > "$D/kernel/Containerfile"; fi
[ -s "$D/kernel/Containerfile" ] || { echo "empty Containerfile" >&2; exit 1; }
VER="${SALU_BUNDLE_VERSION:-$("$BIN" --version 2>/dev/null | awk '{print $2}' || true)}"
printf 'version=%s\narch=%s\nbuilt=%s\n' "${VER:-unknown}" "$ARCH" "$(date -u +%FT%TZ)" > "$D/SALU-BUNDLE"
tar -C "$W" -czf "$OUT/$NAME.tar.gz" "$NAME"
(cd "$OUT" && sha256sum "$NAME.tar.gz" > "$NAME.tar.gz.sha256")
echo "$OUT/$NAME.tar.gz"
