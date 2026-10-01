#!/usr/bin/env bash
# Installs what the salu container kernel needs on an Ubuntu 24.04 box (home server or VPS):
# rootless Podman, gVisor (runsc), and the AppArmor / user-namespace allowance they need.
# Run as root. Safe to run again. Works with or without KVM (gVisor does not need it).
#
#   sudo scripts/install-kernel-runtime.sh [--user NAME] [--no-gvisor] [--check]
#
# --user NAME   the account that runs salu (default: the user who ran sudo, else "salu")
# --no-gvisor   Podman only (containers then share the host kernel directly: weaker)
# --check       change nothing, report what is missing, exit 1 if anything is
set -euo pipefail

USER_NAME="${SUDO_USER:-salu}"
GVISOR=1
CHECK=0
while [ $# -gt 0 ]; do
  case "$1" in
    --user) USER_NAME="$2"; shift 2 ;;
    --no-gvisor) GVISOR=0; shift ;;
    --check) CHECK=1; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
missing=0
need() { if eval "$2" >/dev/null 2>&1; then say "ok:      $1"; else say "missing: $1"; missing=1; fi; return 0; }

if [ "$(id -u)" -ne 0 ] && [ "$CHECK" -eq 0 ]; then say "run as root: sudo $0 $*" >&2; exit 1; fi
if [ -r /etc/os-release ]; then . /etc/os-release; fi
if [ "${ID:-}" != "ubuntu" ] && [ "${ID:-}" != "debian" ]; then say "this script supports Ubuntu and Debian (found ${PRETTY_NAME:-unknown})" >&2; exit 1; fi
ARCH="$(uname -m)"
case "$ARCH" in x86_64) GARCH=x86_64 ;; aarch64) GARCH=aarch64 ;; *) say "unsupported CPU: $ARCH" >&2; exit 1 ;; esac

AA_PROFILE=/etc/apparmor.d/salu-kernel-userns
RUNSC_WRAPPER=/usr/local/bin/runsc-salu
CONF=/etc/containers/containers.conf.d/50-salu-gvisor.conf

if [ "$CHECK" -eq 1 ]; then
  need "podman" "command -v podman"
  need "uidmap (newuidmap)" "command -v newuidmap"
  need "pasta or slirp4netns" "command -v pasta || command -v slirp4netns"
  need "user $USER_NAME exists" "id $USER_NAME"
  need "subuid range for $USER_NAME" "grep -q '^$USER_NAME:' /etc/subuid"
  need "linger for $USER_NAME" "test -e /var/lib/systemd/linger/$USER_NAME"
  [ "$GVISOR" -eq 1 ] && need "gVisor (runsc)" "command -v runsc"
  need "AppArmor allowance for user namespaces" "test ! -e /proc/sys/kernel/apparmor_restrict_unprivileged_userns || test \"\$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns)\" = 0 || test -e $AA_PROFILE"
  exit $missing
fi

say "== packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq podman uidmap passt slirp4netns fuse-overlayfs crun curl ca-certificates apparmor-utils socat >/dev/null

say "== user $USER_NAME"
id "$USER_NAME" >/dev/null 2>&1 || useradd -m -s /bin/bash "$USER_NAME"
grep -q "^$USER_NAME:" /etc/subuid || usermod --add-subuids 100000-165535 "$USER_NAME"
grep -q "^$USER_NAME:" /etc/subgid || usermod --add-subgids 100000-165535 "$USER_NAME"
loginctl enable-linger "$USER_NAME"   # rootless containers keep running with nobody logged in

say "== AppArmor: user namespaces for the container tools only"
# Ubuntu 24.04 blocks unprivileged user namespaces for programs without a profile. Rather than turning that
# restriction off for everything, give these specific programs permission to create them.
if [ -e /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]; then
  PODMAN_BIN="$(command -v podman)"; CRUN_BIN="$(command -v crun)"; BWRAP_BIN="$(command -v bwrap || echo /usr/bin/bwrap)"
  cat > "$AA_PROFILE" <<PROFILE
abi <abi/4.0>,
include <tunables/global>
profile salu-podman $PODMAN_BIN flags=(unconfined) { userns, }
profile salu-crun $CRUN_BIN flags=(unconfined) { userns, }
profile salu-runsc /usr/local/bin/runsc flags=(unconfined) { userns, }
profile salu-bwrap $BWRAP_BIN flags=(unconfined) { userns, }
profile salu-buildah /usr/bin/buildah flags=(unconfined) { userns, }
profile salu-newuidmap /usr/bin/newuidmap flags=(unconfined) { userns, }
PROFILE
  apparmor_parser -r "$AA_PROFILE" || say "warning: could not load $AA_PROFILE; if rootless Podman fails with 'permission denied' on a namespace, run: sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 (system-wide, weaker)"
fi

if [ "$GVISOR" -eq 1 ]; then
  say "== gVisor"
  if ! command -v runsc >/dev/null 2>&1; then
    URL="https://storage.googleapis.com/gvisor/releases/release/latest/$GARCH"
    TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
    ( cd "$TMP" && curl -fsSLO "$URL/runsc" && curl -fsSLO "$URL/runsc.sha512" && sha512sum -c runsc.sha512 )
    install -m 0755 "$TMP/runsc" /usr/local/bin/runsc
  fi
  # Rootless gVisor needs no cgroup ownership, and reaching the egress filter's unix socket needs host-uds.
  cat > "$RUNSC_WRAPPER" <<WRAP
#!/bin/sh
exec /usr/local/bin/runsc --ignore-cgroups --host-uds=open "\$@"
WRAP
  chmod 0755 "$RUNSC_WRAPPER"
  mkdir -p "$(dirname "$CONF")"
  cat > "$CONF" <<CONFIG
[engine.runtimes]
runsc = ["$RUNSC_WRAPPER"]
CONFIG
fi

say "== check"
sudo -u "$USER_NAME" -H sh -c 'cd ~ && podman info --format "rootless={{.Host.Security.Rootless}} runtime={{.Host.OCIRuntime.Name}}"' || say "warning: podman did not start for $USER_NAME (see the message above)"
if [ "$GVISOR" -eq 1 ]; then
  sudo -u "$USER_NAME" -H sh -c 'cd ~ && podman run --rm --runtime runsc --network none docker.io/library/alpine:3 echo "gVisor container works"' || say "warning: a gVisor test container did not run; salu will use Podman's default runtime until this is fixed"
fi
say "done. Next, as $USER_NAME: salu kernel setup && salu kernel login"
