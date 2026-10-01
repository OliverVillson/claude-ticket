#!/usr/bin/env bash
# salu box installer: turns a fresh Ubuntu/Debian machine into an always-on salu box. The same script works on
# a home laptop and on a rented VPS. It prepares the OS, then runs the runner installer.
#
#   curl -fsSL https://raw.githubusercontent.com/OliverVillson/salu/main/scripts/install-box.sh | sudo bash
#   sudo bash install-box.sh --check        # only report what is ready and what is not, change nothing
#
# Options:
#   --check          report only
#   --no-firewall    do not touch the firewall
#   --no-runner      prepare the OS but skip scripts/install-runner.sh
#   --profile P      laptop | vps (default: laptop if a battery or a lid is found and this is bare metal, else vps)
# Environment: SALU_VERSION, SALU_RUNNER_USER are passed to the runner installer. Safe to re-run.
set -euo pipefail

CHECK=0; FIREWALL=1; RUNNER=1; PROFILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=1 ;;
    --no-firewall) FIREWALL=0 ;;
    --no-runner) RUNNER=0 ;;
    --profile) PROFILE="${2:-}"; shift ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

ok()   { printf '\033[38;2;0;255;65m✓\033[0m %s\n' "$*"; }
bad()  { printf '\033[31m✗\033[0m %s\n' "$*"; PROBLEMS=$((PROBLEMS + 1)); }
note() { printf '  %s\n' "$*"; }
PROBLEMS=0

[ "$(uname -s)" = Linux ] || { echo "the box is for Linux" >&2; exit 1; }
if [ "$CHECK" = 0 ]; then
  [ "$(id -u)" = 0 ] || { echo "run as root: sudo bash install-box.sh" >&2; exit 1; }
  [ -d /run/systemd/system ] || { echo "systemd is required" >&2; exit 1; }
  command -v apt-get >/dev/null 2>&1 || { echo "this installer supports Ubuntu and Debian (apt)" >&2; exit 1; }
fi

VIRT="$(systemd-detect-virt 2>/dev/null || true)"; [ -n "$VIRT" ] || VIRT=none
if [ -z "$PROFILE" ]; then
  if [ "$VIRT" = none ] && { ls /sys/class/power_supply/BAT* >/dev/null 2>&1 || [ -e /proc/acpi/button/lid ]; }; then PROFILE=laptop; else PROFILE=vps; fi
fi
case "$PROFILE" in laptop|vps) ;; *) echo "--profile must be laptop or vps" >&2; exit 2 ;; esac

# --- 1. readiness report (always) ---
echo "salu box: profile $PROFILE, $(uname -m), virtualization: $VIRT"
. /etc/os-release 2>/dev/null || true
case "${ID:-}" in ubuntu|debian) ok "${PRETTY_NAME:-$ID}" ;; *) bad "untested distro: ${PRETTY_NAME:-unknown} (Ubuntu 24.04 LTS is the target)" ;; esac

FREE_GB=$(df -BG --output=avail / | tail -1 | tr -dc 0-9)
[ "${FREE_GB:-0}" -ge 60 ] && ok "disk: ${FREE_GB} GB free (60 needed)" || bad "disk: only ${FREE_GB} GB free, at least 60 needed (on Ubuntu an LVM install uses ~100 GB: grow it with lvextend)"
MEM_GB=$(awk '/MemTotal/ {printf "%d", $2/1048576 + 0.5}' /proc/meminfo)
[ "${MEM_GB:-0}" -ge 4 ] && ok "memory: ${MEM_GB} GB" || bad "memory: ${MEM_GB} GB (4 GB or more recommended)"

if grep -qE '(vmx|svm)' /proc/cpuinfo; then
  [ -e /dev/kvm ] && ok "hardware virtualization on, /dev/kvm present (microVM-capable)" \
    || bad "CPU supports virtualization but /dev/kvm is missing (BIOS: enable VT-x/VT-d; on a VPS: nested virtualization is off)"
else
  if [ "$PROFILE" = laptop ]; then bad "no virtualization: turn on Intel VT-x / VT-d in the BIOS"
  else note "no virtualization (normal on most VPSes): containers work, microVMs need a plan with nested virtualization or bare metal"; fi
fi

if [ -r /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]; then
  [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns)" = 0 ] && ok "unprivileged user namespaces allowed" \
    || bad "AppArmor blocks unprivileged user namespaces (Ubuntu 24.04): the sandbox cannot start until this is relaxed (the installer does it)"
fi

if [ "$PROFILE" = laptop ]; then
  [ "$(systemctl is-enabled sleep.target 2>/dev/null || true)" = masked ] && ok "sleep disabled" || bad "sleep not disabled (a closed lid would stop the box)"
  [ -f /sys/class/power_supply/AC/online ] || [ -f /sys/class/power_supply/ACAD/online ] || note "no AC adapter info found"
fi
command -v ufw >/dev/null 2>&1 && ok "ufw installed" || note "ufw not installed (this installer adds it)"

if [ "$CHECK" = 1 ]; then
  echo; [ "$PROBLEMS" = 0 ] && ok "ready" || echo "$PROBLEMS thing(s) to fix: run without --check to fix what can be fixed here"
  exit 0
fi

# --- 2. packages ---
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates git unattended-upgrades cpu-checker >/dev/null
[ "$FIREWALL" = 1 ] && apt-get install -y -qq ufw >/dev/null
ok "packages"

# --- 3. let the sandbox use user namespaces (Ubuntu 24.04 restricts them) ---
if [ -w /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]; then
  echo 'kernel.apparmor_restrict_unprivileged_userns=0' > /etc/sysctl.d/60-salu.conf
  sysctl -q --system >/dev/null
  ok "user namespaces allowed (sandbox can start)"
fi

# --- 4. a laptop must never sleep, lid open or closed ---
if [ "$PROFILE" = laptop ]; then
  mkdir -p /etc/systemd/logind.conf.d
  printf '[Login]\nHandleLidSwitch=ignore\nHandleLidSwitchExternalPower=ignore\nHandleLidSwitchDocked=ignore\n' > /etc/systemd/logind.conf.d/salu-lid.conf
  systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target >/dev/null 2>&1
  systemctl kill -s HUP systemd-logind 2>/dev/null || true
  ok "never sleeps (lid closed is fine)"
fi

# --- 5. firewall: nothing inbound except ssh (salu itself needs no open port) ---
if [ "$FIREWALL" = 1 ]; then
  SSH_PORTS="$(ss -H -tlnp 2>/dev/null | awk '/sshd/ {n=split($4,a,":"); print a[n]}' | sort -u)"; [ -n "$SSH_PORTS" ] || SSH_PORTS=22
  ufw default deny incoming >/dev/null; ufw default allow outgoing >/dev/null
  for p in $SSH_PORTS; do ufw allow "$p/tcp" >/dev/null; done
  ufw --force enable >/dev/null
  ok "firewall: deny inbound, ssh allowed on $(echo $SSH_PORTS | tr '\n' ' ')"
fi

# --- 6. automatic security updates ---
printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' > /etc/apt/apt.conf.d/20auto-upgrades
ok "automatic security updates"

# --- 7. the runner (salu user, salu, Claude Code, systemd template) ---
if [ "$RUNNER" = 1 ]; then
  HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
  if [ -n "$HERE" ] && [ -f "$HERE/install-runner.sh" ]; then bash "$HERE/install-runner.sh"
  else curl -fsSL https://raw.githubusercontent.com/OliverVillson/salu/main/scripts/install-runner.sh | bash; fi
fi

echo
echo "Box ready. Next: make a login token on a machine with a browser (claude setup-token), then see docs/home-server.md"
echo "Check anytime:  sudo bash install-box.sh --check   and   salu runner doctor"
