#!/usr/bin/env bash
# salu installer — macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/OliverVillson/salu/main/scripts/install.sh | bash
#
# Usage (pass args after `bash -s --` when piping):
#   install.sh                 install or update to the latest release
#   install.sh v0.2.0          install a specific version
#   install.sh --uninstall     remove the binary and the PATH line (keeps ~/.salu unless --purge)
#
# Environment:
#   SALU_INSTALL_DIR     where the binary goes            (default: ~/.local/bin)
#   SALU_REPO            GitHub owner/repo to download from (default: OliverVillson/salu)
#   SALU_DOWNLOAD_BASE   override the download URL prefix (testing / mirrors)
#   GITHUB_TOKEN         used for private repos (or be logged in with `gh auth login`)
#   SALU_NO_MODIFY_PATH  set to 1 to leave shell rc files alone
set -euo pipefail

REPO="${SALU_REPO:-OliverVillson/salu}"
# Until the repository rename is everywhere, fall back to its old name when the new one has nothing.
FALLBACK_REPO=""; [ -z "${SALU_REPO:-}" ] && FALLBACK_REPO="OliverVillson/claude-ticket"
INSTALL_DIR="${SALU_INSTALL_DIR:-$HOME/.local/bin}"
BIN="$INSTALL_DIR/salu"
MARK_BEGIN="# >>> salu >>>"
MARK_END="# <<< salu <<<"

if [ -t 1 ]; then G=$'\033[38;2;0;255;65m'; D=$'\033[2m'; R=$'\033[31m'; Z=$'\033[0m'; else G=; D=; R=; Z=; fi
say()  { printf '%s\n' "$*"; }
ok()   { printf '%s✓%s %s\n' "$G" "$Z" "$*"; }
die()  { printf '%s✗ %s%s\n' "$R" "$*" "$Z" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

rc_files() {
  case "$(basename "${SHELL:-}")" in
    zsh)  echo "${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash) if [ "$(uname -s)" = Darwin ]; then echo "$HOME/.bash_profile"; else echo "$HOME/.bashrc"; fi ;;
    fish) echo "$HOME/.config/fish/conf.d/salu.fish" ;;
    *)    echo "$HOME/.profile" ;;
  esac
}

uninstall() {
  rm -f "$BIN" && ok "removed $BIN"
  for f in "$HOME/.zshrc" "${ZDOTDIR:-$HOME}/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile" "$HOME/.config/fish/conf.d/salu.fish"; do
    [ -f "$f" ] || continue
    if grep -qF "$MARK_BEGIN" "$f" 2>/dev/null; then
      tmp="$(mktemp)"
      awk -v b="$MARK_BEGIN" -v e="$MARK_END" '$0==b{skip=1} !skip{print} $0==e{skip=0}' "$f" >"$tmp"
      cat "$tmp" >"$f"; rm -f "$tmp"
      ok "removed PATH line from $f"
    fi
  done
  if [ "${1:-}" = "--purge" ]; then rm -rf "$HOME/.salu" && ok "removed ~/.salu (tickets and logs)"; else say "${D}kept ~/.salu (your tickets); add --purge to delete it${Z}"; fi
  exit 0
}

VERSION=latest; ACTION=install; PURGE=
for a in "$@"; do
  case "$a" in
    --uninstall|uninstall) ACTION=uninstall ;;
    --purge) PURGE=--purge ;;
    -h|--help) say "usage: install.sh [vX.Y.Z] [--uninstall [--purge]]"; exit 0 ;;
    v[0-9]*|[0-9]*) VERSION="${a#v}"; VERSION="v$VERSION" ;;
    *) die "unknown argument: $a" ;;
  esac
done
[ "$ACTION" = uninstall ] && uninstall "$PURGE"

# --- platform -------------------------------------------------------------
case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) die "unsupported OS: $(uname -s) (macOS and Linux only)" ;; esac
arch="$(uname -m)"
case "$arch" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) die "unsupported CPU: $arch" ;; esac
# Rosetta shells report x86_64 on Apple Silicon; prefer the native build.
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = 1 ]; then arch=arm64; fi
if [ "$os" = linux ] && { [ -f /etc/alpine-release ] || (ldd --version 2>&1 | grep -qi musl); }; then
  die "musl-based Linux (Alpine) has no prebuilt salu yet; build from source: bun run build"
fi
asset="salu-$os-$arch"

have curl || have wget || die "need curl or wget"

# --- download -------------------------------------------------------------
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

fetch() { # url dest  (public)
  if have curl; then curl -fsSL --retry 3 -o "$2" "$1"; else wget -q -O "$2" "$1"; fi
}

download_base() { # $1 = owner/repo
  if [ "$VERSION" = latest ]; then echo "https://github.com/$1/releases/latest/download"; else echo "https://github.com/$1/releases/download/$VERSION"; fi
}
if [ -n "${SALU_DOWNLOAD_BASE:-}" ]; then
  base="$SALU_DOWNLOAD_BASE"
else
  base="$(download_base "$REPO")"
fi

say "${G}salu${Z} installing ($asset, $VERSION)…"
if fetch "$base/$asset" "$tmp/salu" 2>/dev/null && fetch "$base/$asset.sha256" "$tmp/salu.sha256" 2>/dev/null; then
  :
elif [ -n "$FALLBACK_REPO" ] && [ -z "${SALU_DOWNLOAD_BASE:-}" ] \
  && fetch "$(download_base "$FALLBACK_REPO")/$asset" "$tmp/salu" 2>/dev/null && fetch "$(download_base "$FALLBACK_REPO")/$asset.sha256" "$tmp/salu.sha256" 2>/dev/null; then
  :
elif [ -n "${GITHUB_TOKEN:-}" ] || { have gh && gh auth status >/dev/null 2>&1; }; then
  # Private repo (or anonymous download blocked): go through the authenticated GitHub CLI.
  have gh || die "a private repo needs the GitHub CLI: https://cli.github.com"
  tag=(); [ "$VERSION" != latest ] && tag=("$VERSION")
  gh release download ${tag[@]+"${tag[@]}"} --repo "$REPO" --pattern "$asset" --pattern "$asset.sha256" --dir "$tmp" --clobber \
    || die "gh could not download the release from $REPO"
  mv "$tmp/$asset" "$tmp/salu"; mv "$tmp/$asset.sha256" "$tmp/salu.sha256"
else
  die "could not download $base/$asset
  • no release published yet? tag one (git tag v0.1.0 && git push --tags) and wait for the Release workflow
  • repo private? make it public, or run \`gh auth login\` (or set GITHUB_TOKEN) and re-run this installer"
fi

# --- verify ---------------------------------------------------------------
want="$(awk '{print $1}' "$tmp/salu.sha256")"
if have sha256sum; then got="$(sha256sum "$tmp/salu" | awk '{print $1}')"; else got="$(shasum -a 256 "$tmp/salu" | awk '{print $1}')"; fi
[ -n "$want" ] && [ "$want" = "$got" ] || die "checksum mismatch (expected $want, got $got) — download corrupted, try again"
ok "checksum verified"

# --- install --------------------------------------------------------------
mkdir -p "$INSTALL_DIR"
chmod +x "$tmp/salu"
[ "$os" = darwin ] && xattr -d com.apple.quarantine "$tmp/salu" 2>/dev/null || true
"$tmp/salu" --version >/dev/null 2>&1 || die "downloaded binary does not run on this machine"
mv -f "$tmp/salu" "$BIN"   # atomic replace, safe while salu is running
ok "installed $BIN ($("$BIN" --version 2>/dev/null | head -1))"

# --- PATH -----------------------------------------------------------------
on_path=
case ":$PATH:" in *":$INSTALL_DIR:"*) on_path=1 ;; esac
if [ -z "$on_path" ] && [ "${SALU_NO_MODIFY_PATH:-}" != 1 ]; then
  rc="$(rc_files)"
  mkdir -p "$(dirname "$rc")"; touch "$rc"
  if ! grep -qF "$MARK_BEGIN" "$rc"; then
    if [ "$(basename "$rc")" = salu.fish ]; then line="fish_add_path \"$INSTALL_DIR\""; else line="export PATH=\"$INSTALL_DIR:\$PATH\""; fi
    printf '\n%s\n%s\n%s\n' "$MARK_BEGIN" "$line" "$MARK_END" >>"$rc"
    ok "added $INSTALL_DIR to PATH in $rc"
  fi
  say ""
  say "Open a new terminal, or run:  ${G}export PATH=\"$INSTALL_DIR:\$PATH\"${Z}"
fi

say ""
say "${G}Hackermode ready.${Z} Start with:"
say "  ${G}salu${Z}                     open the TUI"
say "  ${G}salu add \"fix login\" \"…\"${Z}  queue a ticket"
say "${D}update: re-run this installer · uninstall: curl -fsSL <install-url> | bash -s -- --uninstall${Z}"
