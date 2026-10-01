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
# Environment: SALU_VERSION, SALU_BINARY (a locally built salu, to run a branch before it is released), SALU_RUNNER_USER are passed to the runner installer. Safe to re-run.
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
    || { [ "$PROFILE" = laptop ] && bad "CPU supports virtualization but /dev/kvm is missing (BIOS: enable VT-x/VT-d)" || note "/dev/kvm missing: fine on a VPS"; }
else
  if [ "$PROFILE" = laptop ]; then bad "no virtualization: turn on Intel VT-x / VT-d in the BIOS"
  else note "no hardware virtualization (normal on a VPS): fine, not required there"; fi
fi

if [ -r /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]; then
  [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns)" = 0 ] || [ -f /etc/apparmor.d/salu-bwrap ] && ok "bubblewrap may use user namespaces" \
    || bad "AppArmor blocks user namespaces for bubblewrap (Ubuntu 24.04): the installer adds a profile for it"
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
apt-get install -y -qq curl ca-certificates git unattended-upgrades cpu-checker bubblewrap socat apparmor >/dev/null
[ "$FIREWALL" = 1 ] && apt-get install -y -qq ufw >/dev/null
ok "packages"

# --- 3. let bubblewrap (and only bubblewrap) use user namespaces: Ubuntu 24.04 restricts them via AppArmor ---
if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = 1 ]; then
  BWRAP="$(command -v bwrap || true)"
  if [ -n "$BWRAP" ] && command -v apparmor_parser >/dev/null 2>&1; then
    BWRAP="$(readlink -f "$BWRAP")"
    printf 'abi <abi/4.0>,\ninclude <tunables/global>\n\nprofile salu-bwrap %s flags=(unconfined) {\n  userns,\n  include if exists <local/salu-bwrap>\n}\n' "$BWRAP" > /etc/apparmor.d/salu-bwrap
    apparmor_parser -r /etc/apparmor.d/salu-bwrap
    ok "AppArmor profile lets bubblewrap use user namespaces (the system-wide restriction stays on)"
  else
    bad "AppArmor blocks user namespaces and no bubblewrap/apparmor_parser to write a profile for it"
  fi
fi

# --- 3b. compressed swap in RAM (zram): a cushion for memory bursts when several tickets run at once, with no SSD wear ---
if apt-get install -y -qq zram-tools >/dev/null 2>&1; then
  printf 'ALGO=zstd\nPERCENT=50\nPRIORITY=100\n' > /etc/default/zramswap   # up to half of RAM as compressed swap (about 8 GB on a 16 GB box)
  printf 'vm.swappiness=100\nvm.page-cluster=0\n' > /etc/sysctl.d/61-salu-zram.conf   # zram is fast: prefer it over dropping file cache
  sysctl -q --system >/dev/null
  systemctl enable zramswap >/dev/null 2>&1 || true
  systemctl restart zramswap >/dev/null 2>&1 || true
  if swapon --show=NAME --noheadings | grep -q zram; then ok "compressed swap (zram, up to half of RAM)"; else bad "zram swap did not start (journalctl -u zramswap)"; fi
else
  note "zram-tools not available here: skipped compressed swap"
fi

# --- 4. a laptop must never sleep, lid open or closed ---
if [ "$PROFILE" = laptop ]; then
  mkdir -p /etc/systemd/logind.conf.d
  printf '[Login]\nHandleLidSwitch=ignore\nHandleLidSwitchExternalPower=ignore\nHandleLidSwitchDocked=ignore\n' > /etc/systemd/logind.conf.d/salu-lid.conf
  systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target >/dev/null 2>&1
  systemctl kill -s HUP systemd-logind 2>/dev/null || true
  ok "never sleeps (lid closed is fine)"
  # an always-on laptop lives or dies by heat: thermald keeps an Intel CPU out of throttling and the fans sane
  apt-get install -y -qq thermald lm-sensors >/dev/null && systemctl enable --now thermald >/dev/null 2>&1 && ok "thermal management (thermald)"
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

# --- 8. container runtime for the safe kernel (Podman, gVisor, scoped AppArmor): scripts/install-kernel-runtime.sh ---
KERNEL_SH="${SALU_KERNEL_INSTALLER:-}"
if [ -z "$KERNEL_SH" ] && [ -n "${HERE:-}" ] && [ -f "$HERE/install-kernel-runtime.sh" ]; then KERNEL_SH="$HERE/install-kernel-runtime.sh"; fi
if [ -z "$KERNEL_SH" ]; then
  KERNEL_SH="$(mktemp)"
  curl -fsSL https://raw.githubusercontent.com/OliverVillson/salu/main/scripts/install-kernel-runtime.sh -o "$KERNEL_SH" 2>/dev/null || { rm -f "$KERNEL_SH"; KERNEL_SH=""; }
fi
if [ -n "$KERNEL_SH" ] && [ -f "$KERNEL_SH" ]; then
  if bash "$KERNEL_SH" --user "${SALU_RUNNER_USER:-salu}"; then
    ok "container runtime for the safe kernel"
    KERNEL_DONE=1
    # On a box every ticket must run in the container: a ticket that cannot get one fails instead of running in the weaker fence.
    mkdir -p /etc/systemd/system/salu@.service.d
    printf '[Service]\nEnvironment=SALU_KERNEL_REQUIRE=1\n' > /etc/systemd/system/salu@.service.d/10-kernel.conf
    systemctl daemon-reload
    ok "tickets on this box require the container kernel (SALU_KERNEL_REQUIRE=1; they fail rather than run in the fence)"
  else
    bad "the container runtime did not install or does not run: tickets here would use the weaker fence until it does (fix the message above and run this script again)"
  fi
else
  note "safe-kernel container runtime: skipped (install-kernel-runtime.sh is not available yet; set SALU_KERNEL_INSTALLER=<script> to use another copy)"
fi

echo
echo "Box ready. Next: make a login token on a machine with a browser (claude setup-token), then see docs/home-server.md"
if [ "${KERNEL_DONE:-0}" = 1 ]; then
  echo "Then, as the runner user, build the container kernel and give it its own login token:"
  echo "  sudo -iu ${SALU_RUNNER_USER:-salu} salu kernel setup      # builds the image (a few GB, once)"
  echo "  sudo -iu ${SALU_RUNNER_USER:-salu} salu kernel login      # an agent token from claude setup-token; revocable"
  echo "  sudo -iu ${SALU_RUNNER_USER:-salu} salu doctor --sandbox  # attacks a throwaway container; every line a green check"
  echo "Until the image and login exist, tickets on this box fail with a message rather than run unprotected."
fi
echo "Check anytime:  sudo bash install-box.sh --check   and   salu runner doctor"
