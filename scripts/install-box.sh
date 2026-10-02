#!/usr/bin/env bash
# salu box installer: turns a fresh Ubuntu/Debian machine into an always-on salu box. The same script works on
# a home laptop and on a rented VPS. It prepares the OS, then runs the runner installer.
#
#   curl -fsSL <release>/install-box.sh | sudo bash     (the release page of OliverVillson/salu; see docs/home-server.md)
#   sudo bash /var/lib/salu-installer/install-box.sh     run it again (an update, or after a dropped ssh session)
#   sudo bash install-box.sh --check        # only report what is ready and what is not, change nothing
#
# Fetches ONE bundle from the release (the salu binary, the three installer scripts, the kernel Containerfile): the box
# needs no git, no bun and no branch merges. The work runs detached, logged to /var/log/salu-install.log, so an ssh
# drop does not stop it; run the installer again and it shows the log and carries on. Every step is safe to repeat.
# It ends by building the container kernel (salu kernel setup --yes) and making the box's keys (salu box init --json);
# the last line it prints is that JSON.
#
# Options:
#   --check          report only
#   --no-firewall    do not touch the firewall
#   --no-runner      prepare the OS but skip scripts/install-runner.sh
#   --no-image       do not build the container kernel image (salu kernel setup --yes)
#   --no-init        do not make the box's keys (salu box init --json)
#   --name NAME      the box's name for pairing (default: the host name)
#   --foreground     do not detach; run here and stop when this shell stops
#   --profile P      laptop | vps (default: laptop if a battery or a lid is found and this is bare metal, else vps)
# Environment: SALU_VERSION (a release tag, default latest), SALU_REPO, SALU_DOWNLOAD_BASE (a mirror),
# SALU_BINARY (a locally built salu, to run a branch before it is released), SALU_RUNNER_USER are passed on. Safe to re-run.
set -euo pipefail

CHECK=0; FIREWALL=1; RUNNER=1; IMAGE=1; INIT=1; BOXNAME=""; FOREGROUND="${SALU_INSTALL_FOREGROUND:-0}"; PROFILE=""
ARGS=("$@")
while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=1 ;;
    --no-firewall) FIREWALL=0 ;;
    --no-runner) RUNNER=0 ;;
    --no-image) IMAGE=0 ;;
    --no-init) INIT=0 ;;
    --foreground) FOREGROUND=1 ;;
    --name) BOXNAME="${2:-}"; shift ;;
    --profile) PROFILE="${2:-}"; shift ;;
    -h|--help) sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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
  [ -d "${SALU_SYSTEMD_RUN:-/run/systemd/system}" ] || { echo "systemd is required" >&2; exit 1; }
  command -v apt-get >/dev/null 2>&1 || { echo "this installer supports Ubuntu and Debian (apt)" >&2; exit 1; }
fi

# --- 0. where are we running from? A bundle (release), a source checkout (scripts/), or piped from curl (fetch the bundle) ---
SELF="$(readlink -f "${BASH_SOURCE[0]:-$0}" 2>/dev/null || true)"
HERE=""; [ -f "$SELF" ] && HERE="$(dirname "$SELF")"
BUNDLE=0; [ -n "$HERE" ] && [ -f "$HERE/SALU-BUNDLE" ] && BUNDLE=1
SOURCE=0; [ -n "$HERE" ] && [ -f "$HERE/install-runner.sh" ] && SOURCE=1
LOG="${SALU_INSTALL_LOG:-/var/log/salu-install.log}"; LOCK="${SALU_INSTALL_LOCK:-/run/salu-install.lock}"; RCFILE="$LOG.rc"
INSTALLER_DIR="${SALU_INSTALLER_DIR:-/var/lib/salu-installer}"
RUNNER_USER="${SALU_RUNNER_USER:-salu}"

running() { ( flock -n 9 ) 9>"$LOCK" 2>/dev/null && return 1 || return 0; }
# Show an install that is already running (or just ended), wait for it, and pass on how it ended.
attach() {
  echo "an install is already running: showing its log ($LOG). Ctrl+C stops watching, not the install."
  tail -n 5 -f "$LOG" & local T=$!
  flock "$LOCK" true
  sleep 1; kill "$T" 2>/dev/null || true
  exit "$(cat "$RCFILE" 2>/dev/null || echo 0)"
}

if [ "$CHECK" = 0 ] && [ "${SALU_INSTALL_CHILD:-}" != 1 ]; then
  mkdir -p "$(dirname "$LOG")" "$(dirname "$LOCK")"; touch "$LOG"
  running && attach
  if [ "$BUNDLE" = 0 ] && [ "$SOURCE" = 0 ] && [ -z "${SALU_BINARY:-}" ]; then
    # piped from curl: fetch the bundle for this machine, check it, and run its copy of this script
    case "$(uname -m)" in x86_64|amd64) A=x64 ;; aarch64|arm64) A=arm64 ;; *) echo "unsupported CPU: $(uname -m)" >&2; exit 1 ;; esac
    command -v curl >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq curl ca-certificates >/dev/null; }
    REPO="${SALU_REPO:-OliverVillson/salu}"; V="${SALU_VERSION:-latest}"
    if [ -n "${SALU_DOWNLOAD_BASE:-}" ]; then BASE="$SALU_DOWNLOAD_BASE"
    elif [ "$V" = latest ]; then BASE="https://github.com/$REPO/releases/latest/download"
    else BASE="https://github.com/$REPO/releases/download/$V"; fi
    T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
    echo "downloading salu-box-linux-$A ($V)..."
    curl -fsSL --retry 3 -o "$T/b.tar.gz" "$BASE/salu-box-linux-$A.tar.gz" || { echo "could not download $BASE/salu-box-linux-$A.tar.gz (is there a release yet?)" >&2; exit 1; }
    curl -fsSL --retry 3 -o "$T/b.sha256" "$BASE/salu-box-linux-$A.tar.gz.sha256" || { echo "could not download the checksum" >&2; exit 1; }
    [ "$(sha256sum "$T/b.tar.gz" | cut -d' ' -f1)" = "$(cut -d' ' -f1 "$T/b.sha256")" ] || { echo "the download does not match its checksum: not installing it" >&2; exit 1; }
    rm -rf "$INSTALLER_DIR.new"; mkdir -p "$INSTALLER_DIR.new"
    tar -xzf "$T/b.tar.gz" -C "$INSTALLER_DIR.new" --strip-components=1
    rm -rf "$INSTALLER_DIR"; mv "$INSTALLER_DIR.new" "$INSTALLER_DIR"
    trap - EXIT; rm -rf "$T"
    exec bash "$INSTALLER_DIR/install-box.sh" "${ARGS[@]}"
  fi
  if [ "$FOREGROUND" = 0 ] && [ -f "$SELF" ]; then
    # run detached from this terminal: an ssh drop sends SIGHUP here, not to the install
    START=$(( $(wc -l < "$LOG") + 1 ))
    setsid env SALU_INSTALL_CHILD=1 bash "$SELF" "${ARGS[@]}" >>"$LOG" 2>&1 </dev/null &
    CHILD=$!
    echo "salu box install started (log: $LOG). If this connection drops, run it again to carry on."
    tail -n "+$START" -f "$LOG" --pid="$CHILD" 2>/dev/null &
    TAILP=$!
    RC=0; wait "$CHILD" || RC=$?
    sleep 1; kill "$TAILP" 2>/dev/null || true
    exit "$RC"
  fi
fi
if [ "${SALU_INSTALL_CHILD:-}" = 1 ]; then
  exec 9>"$LOCK"; flock -n 9 || { echo "another install holds the lock"; exit 75; }
  trap 'echo $? > "$RCFILE"' EXIT
  echo "--- salu box install $(date -u +%FT%TZ) ---"
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
if command -v runsc >/dev/null 2>&1; then
  grep -qs 'SALU_KERNEL_REQUIRE=1' /etc/systemd/system/salu-runner@.service.d/10-kernel.conf && ok "runner tickets require the container kernel" \
    || bad "runner tickets could fall back to the weaker fence: SALU_KERNEL_REQUIRE=1 is not set on salu-runner@ (run this script again)"
fi

if [ "$CHECK" = 1 ]; then
  echo; [ "$PROBLEMS" = 0 ] && ok "ready" || echo "$PROBLEMS thing(s) to fix: run without --check to fix what can be fixed here"
  exit 0
fi

# --- 2. packages ---
PROBLEMS=0   # the report above is what was; from here on, count what is still wrong after the fixes
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
# From a bundle the salu inside it is the one installed, so the box needs no git, bun or branch merges.
[ "$BUNDLE" = 1 ] && [ -z "${SALU_BINARY:-}" ] && export SALU_BINARY="$HERE/salu"
if [ "$RUNNER" = 1 ]; then
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
    # on the runner's unit (salu-runner@, see src/core/runner.ts); earlier versions of this script wrote it to a unit that does not exist
    rm -rf /etc/systemd/system/salu@.service.d
    mkdir -p /etc/systemd/system/salu-runner@.service.d
    printf '[Service]\nEnvironment=SALU_KERNEL_REQUIRE=1\n' > /etc/systemd/system/salu-runner@.service.d/10-kernel.conf
    systemctl daemon-reload
    ok "tickets on this box require the container kernel (SALU_KERNEL_REQUIRE=1; they fail rather than run in the fence)"
  else
    bad "the container runtime did not install or does not run: tickets here would use the weaker fence until it does (fix the message above and run this script again)"
  fi
else
  note "safe-kernel container runtime: skipped (install-kernel-runtime.sh is not available yet; set SALU_KERNEL_INSTALLER=<script> to use another copy)"
fi

# --- 9. the container kernel image: built once per version, over ssh, no terminal needed (a changed image recreates old containers) ---
SALU_AS="runuser -u $RUNNER_USER --"
if [ "${KERNEL_DONE:-0}" = 1 ] && [ "$IMAGE" = 1 ]; then
  if (cd / && $SALU_AS env HOME="$(getent passwd "$RUNNER_USER" | cut -d: -f6)" salu kernel setup --yes); then ok "container kernel image"
  else bad "the kernel image did not build (see above): run this script again and it carries on"; fi
fi

# --- 10. the box's keys for pairing with a Mac (docs/control-channel.md); nothing changes when it is run again ---
# Made by root, in a folder only root reads: the control service runs as root, and the agents (the salu user) never see these keys.
INIT_JSON=""
if [ "$INIT" = 1 ]; then
  NAME_ARGS=(); [ -n "$BOXNAME" ] && NAME_ARGS=(--name "$BOXNAME")
  if INIT_JSON="$(cd / && salu box init --json ${NAME_ARGS[@]+"${NAME_ARGS[@]}"})"; then ok "box keys"
  else bad "salu box init failed: run this script again"; INIT_JSON=""; fi
fi

# --- 11. the control service (commands from the Mac, see src/control): enabled here, started by the pairing step ---
# It runs as root (runner add needs that). A handler cannot restart its own service, so this script does: after an update
# it restarts the service if it was running (an update handler must start this script in its own unit: systemd-run --no-block).
if salu control unit >/tmp/salu-control.unit 2>/dev/null && [ -s /tmp/salu-control.unit ]; then
  grep -v '^User=' /tmp/salu-control.unit > /etc/systemd/system/salu-control.service   # no User= line: root
  rm -f /tmp/salu-control.unit
  systemctl daemon-reload; systemctl enable salu-control.service >/dev/null 2>&1 || true
  systemctl try-restart salu-control.service >/dev/null 2>&1 || true
  ok "control service installed (runs as root, restarts itself after an update)"
else
  bad "could not get the control service unit from salu (salu control unit)"
fi

echo
if [ "$PROBLEMS" = 0 ]; then echo "Box ready."; else echo "Box installed, with $PROBLEMS thing(s) to fix (see the ✗ lines above)."; fi
echo "Next, on your Mac:  salu box add <user>@<this host>"
echo "By hand instead:  see docs/home-server.md.  Check anytime:  sudo bash $0 --check  and  salu doctor --sandbox"
[ -n "$INIT_JSON" ] && echo "$INIT_JSON"
[ "$PROBLEMS" = 0 ]
