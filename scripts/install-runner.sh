#!/usr/bin/env bash
# salu runner installer: turns a fresh always-on Linux box (Debian/Ubuntu/Fedora/RHEL family, systemd)
# into a place where salu runs tickets unattended.
#
#   curl -fsSL https://raw.githubusercontent.com/OliverVillson/salu/main/scripts/install-runner.sh | sudo bash
#
# Environment:
#   SALU_RUNNER_USER   Linux user that runs the orchestrators and holds the Claude login (default: salu, created if missing)
#   SALU_VERSION       release to install (default: latest), e.g. v0.3.0
#   SALU_BINARY        install this already-built salu binary instead of a release (for running a branch before it is released)
# Afterwards: run `claude setup-token` somewhere with a browser, then
#   sudo salu runner add <project> --clone <git-url> --token-file <file>
set -euo pipefail

[ "$(id -u)" = 0 ] || { echo "run as root: curl -fsSL <url> | sudo bash" >&2; exit 1; }
[ "$(uname -s)" = Linux ] || { echo "the runner is for Linux boxes" >&2; exit 1; }
[ -d /run/systemd/system ] || { echo "systemd is required (for restart and start on boot)" >&2; exit 1; }

RUNNER_USER="${SALU_RUNNER_USER:-salu}"
BASE="https://raw.githubusercontent.com/OliverVillson/salu/main/scripts/install.sh"
ok() { printf '\033[38;2;0;255;65m✓\033[0m %s\n' "$*"; }

# 1. packages: git for clone/push-side work, bubblewrap + socat for the sandbox (on by default on the runner)
if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq && apt-get install -y -qq git curl ca-certificates bubblewrap socat
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y -q git curl ca-certificates bubblewrap socat
elif command -v yum >/dev/null 2>&1; then
  yum install -y -q git curl ca-certificates bubblewrap socat
else
  echo "no apt, dnf or yum found: install git, curl, bubblewrap and socat yourself, then re-run" >&2; exit 1
fi
ok "packages (git, bubblewrap, socat)"

# 2. the runner user (its ~/.claude holds the one Claude login every project on this box shares)
id "$RUNNER_USER" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$RUNNER_USER"
ok "user $RUNNER_USER"

# 3. salu itself, system-wide
if [ -n "${SALU_BINARY:-}" ]; then
  [ -x "$SALU_BINARY" ] || { echo "SALU_BINARY=$SALU_BINARY is not an executable file (build it with: bun run build)" >&2; exit 1; }
  install -m 0755 "$SALU_BINARY" /usr/local/bin/salu
  ok "salu from $SALU_BINARY ($(/usr/local/bin/salu --version 2>/dev/null || echo unknown))"
else
  curl -fsSL "$BASE" | SALU_INSTALL_DIR=/usr/local/bin SALU_NO_MODIFY_PATH=1 bash -s -- ${SALU_VERSION:-}
fi

# 4. Claude Code, as the runner user (lands in ~/.local/bin, which the systemd unit puts on PATH)
if ! runuser -u "$RUNNER_USER" -- bash -lc 'command -v claude >/dev/null || [ -x "$HOME/.local/bin/claude" ]'; then
  runuser -u "$RUNNER_USER" -- bash -lc 'curl -fsSL https://claude.ai/install.sh | bash'
fi
ok "Claude Code for $RUNNER_USER"

# 5. the systemd template (one service per project)
/usr/local/bin/salu runner setup --user "$RUNNER_USER"

echo
echo "Next, once:  run  claude setup-token  on any machine with a browser and save the token to a file (or use an API key: --auth api-key)"
echo "Then:        sudo salu runner add <project> --clone <git-url> --token-file <file>"
echo "Check:       salu runner doctor"
