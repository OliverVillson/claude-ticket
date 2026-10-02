#!/usr/bin/env bash
# Builds the GitHub Pages site: short install URLs that are plain copies of the scripts.
#   <site>/i     scripts/install.sh      (the Mac and Linux CLI)
#   <site>/box   scripts/install-box.sh  (the box, run through `salu box add`)
# Usage: scripts/build-site.sh [outdir]   (default: _site)
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:-$root/_site}"
rm -rf "$out"; mkdir -p "$out"
cp "$root/site/index.html" "$out/index.html"
cp "$root/scripts/install.sh" "$out/i"
cp "$root/scripts/install-box.sh" "$out/box"
touch "$out/.nojekyll"
echo "site built in $out"
