#!/usr/bin/env bash
# Server architecture tests for a salu box (home server or VPS). Run on the box, as the user that runs salu,
# once the box installer (scripts/install-box.sh) and the kernel runtime (scripts/install-kernel-runtime.sh)
# have run, `salu kernel setup` has built the image and `salu kernel login` has saved a token.
#
#   scripts/box-tests.sh                 free checks: nothing is billed, nothing outside a scratch folder is changed
#   scripts/box-tests.sh --tickets       also run small real tickets (haiku, a few cents of subscription use)
#   scripts/box-tests.sh --sudo          also run the installers' --check modes (asks for your sudo password)
#   scripts/box-tests.sh --only 2.3,4.2  run just these tests (ids as in the "Salu server architecture tests" doc)
#   scripts/box-tests.sh --list          print the tests and which ones are automated
#
# Run it as yourself (for example `oliver`): it runs the tests as the salu user with `sudo -u salu -H` (set SALU_BOX_USER to
# change the name), after doing the two --sudo installer checks itself. If you are already that user it just runs.
# The image must be built (`salu kernel setup`) and the token saved (`salu kernel login`) first; both need an interactive terminal.
#
# Every test prints PASS, FAIL, SKIP (could not run here, with why) or MANUAL (needs you), with the evidence.
# A summary is printed at the end and saved to ~/salu-box-tests-<time>.txt: paste it back.
# Exit status is 1 if anything FAILed.
set -uo pipefail

HERE="${SALU_BOX_TESTS_HERE:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
SALU="${SALU:-salu}"
PODMAN="${SALU_CONTAINER_ENGINE:-podman}"
ORIG_ARGS=("$@")
WITH_TICKETS=0; WITH_SUDO=0; ONLY=""; LIST=0
while [ $# -gt 0 ]; do
  case "$1" in
    --tickets) WITH_TICKETS=1; shift ;;
    --sudo) WITH_SUDO=1; shift ;;
    --only) ONLY=",$2,"; shift 2 ;;
    --list) LIST=1; shift ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

REPORT="${SALU_BOX_TESTS_REPORT:-$HOME/salu-box-tests-$(date +%Y%m%d-%H%M%S).txt}"
declare -a RESULTS=()
NFAIL=0

# --- reporting -------------------------------------------------------------------------------------------------
if [ -t 1 ]; then G=$'\e[32m'; R=$'\e[31m'; D=$'\e[2m'; N=$'\e[0m'; else G=""; R=""; D=""; N=""; fi
record() { # status id title evidence
  local st="$1" id="$2" title="$3" ev="${4:-}"
  RESULTS+=("$st|$id|$title|$ev")
  case "$st" in
    PASS) printf '%s PASS%s   %-4s %s\n' "$G" "$N" "$id" "$title" ;;
    FAIL) printf '%s FAIL%s   %-4s %s\n' "$R" "$N" "$id" "$title"; NFAIL=$((NFAIL + 1)) ;;
    SKIP) printf '%s SKIP%s   %-4s %s\n' "$D" "$N" "$id" "$title" ;;
    MANUAL) printf '%s MANUAL%s %-4s %s\n' "$D" "$N" "$id" "$title" ;;
  esac
  [ -n "$ev" ] && printf '%s\n' "$ev" | head -n 12 | sed "s/^/         $D/;s/\$/$N/"
  return 0
}
selected() { [ -z "$ONLY" ] || case "$ONLY" in *",$1,"*) return 0 ;; *) return 1 ;; esac; }
have() { command -v "$1" >/dev/null 2>&1; }
pass() { record PASS "$@"; }
fail() { record FAIL "$@"; }
skip() { record SKIP "$@"; }
manual() { record MANUAL "$@"; }

# id | kind | title      (kind: auto, tickets = auto with --tickets, sudo = auto with --sudo, runner = needs both, manual)
TESTS='1.1|sudo|Installer check (install-box.sh --check)
1.2|manual|Reboot survival
1.3|manual|Heat and load (sensors output collected)
1.4|auto|Inbound closed (only ssh listens beyond loopback)
2.1|sudo|Kernel runtime check (install-kernel-runtime.sh --check)
2.2|tickets|Kernel check ticket runs in a container
2.3|auto|Doctor attacks a throwaway container
2.4|auto|No silent fallback when the container is unavailable
2.5|tickets|Installs stay in the kernel, nothing changes on the host
2.6|tickets|Isolation between projects
2.7|tickets|Disk cap refuses a project that is over its limit
3.1|tickets|Web works on ports 80 and 443
3.2|auto|Blocked address ranges (private, localhost, link-local, metadata, IPv6 spellings)
3.3|auto|Other ports refused
4.1|tickets|Concurrency: how many ran at once, and the wait reason
4.2|auto|Bench: gVisor platforms compared
4.3|tickets|Idle unload and restart
4.4|tickets|Idle timeout setting 0 stops a container right after its last ticket
4.5|tickets|A background process an agent leaves is gone after the stop
4.6|tickets|Start-time log and the median/worst shown by salu kernel
4.7|auto|Platform setting and comparison
4.8|tickets|Box-wide slot cap and slot files cleaned up
5.1|auto|Token login present and used
5.4|runner|Ticket through the real salu-runner@ unit runs in the container (throwaway runner project)
5.2|manual|Expired login is reported, not retried in a loop
5.3|manual|Advise-mode scheduler for a day
6.1|manual|Git sync from a second machine
6.2|manual|Signing key: unsigned or wrongly signed tickets are rejected
6.3|auto|ntfy test notification is sent (you confirm it arrived)
6.4|manual|iPhone app creates a ticket and shows the answer
7.1|manual|Breaker run against the real box'
if [ "$LIST" = 1 ]; then
  while IFS='|' read -r id kind title; do printf '%-4s %-8s %s\n' "$id" "$kind" "$title"; done <<<"$TESTS"
  exit 0
fi
kind_of() { printf '%s\n' "$TESTS" | awk -F'|' -v id="$1" '$1==id{print $2}'; }
title_of() { printf '%s\n' "$TESTS" | awk -F'|' -v id="$1" '$1==id{print $3}'; }
run_ok() { # id: should this test run now? records SKIP/MANUAL itself when not
  local id="$1" k; k="$(kind_of "$id")"
  selected "$id" || return 1
  if [ -n "${SALU_BOX_TESTS_REEXEC:-}" ]; then case "$id" in 1.1|2.1) return 1 ;; esac; fi # done before the switch to the salu user
  case "$k" in
    manual) manual "$id" "$(title_of "$id")"; return 1 ;;
    tickets) [ "$WITH_TICKETS" = 1 ] || { skip "$id" "$(title_of "$id")" "run with --tickets"; return 1; } ;;
    runner) return 1 ;; # runs in the root phase before the switch to the salu user (pre_runner)
    sudo) [ "$WITH_SUDO" = 1 ] || { skip "$id" "$(title_of "$id")" "run with --sudo"; return 1; } ;;
  esac
  return 0
}

# --- run as the salu user -------------------------------------------------------------------------------------
# On the box you log in as yourself (for example `oliver`) and salu runs as the `salu` user, with its own home,
# data folder and rootless Podman. The tests must see what salu sees, so unless this already is that user the
# script copies itself to /tmp and runs again as `salu` (`sudo -u salu -H`). The two installer checks (1.1, 2.1)
# need root, which salu does not have, so they run first, here, and their results are handed over.
SALU_USER="${SALU_BOX_USER:-salu}"
PRE="${SALU_BOX_TESTS_PRE:-}"
if [ -z "${SALU_BOX_TESTS_REEXEC:-}" ] && [ "$LIST" = 0 ] && [ "$(id -un)" != "$SALU_USER" ] && getent passwd "$SALU_USER" >/dev/null 2>&1; then
  PRE="$(mktemp /tmp/salu-box-tests-pre.XXXXXX)"
  enc() { printf '%s' "$1" | tr '\n' '\037'; }
  pre_check() { # id script [more args]: the installer's --check; install-box.sh --check exits 0 even when it finds a ✗
    selected "$1" || return 0
    [ "$WITH_SUDO" = 1 ] || return 0
    local out rc title; title="$(title_of "$1")"
    if [ -x "$HERE/$2" ]; then
      out="$(sudo "$HERE/$2" --check "${@:3}" 2>&1)"; rc=$?
      if [ $rc -eq 0 ] && ! printf '%s' "$out" | grep -q '✗'; then printf 'PASS|%s|%s|%s\n' "$1" "$title" "$(enc "$(printf '%s' "$out" | tail -n 8)")" >>"$PRE"
      else printf 'FAIL|%s|%s|%s\n' "$1" "$title" "$(enc "exit $rc"$'\n'"$(printf '%s' "$out" | grep -v '^ok' | tail -n 10)")" >>"$PRE"; fi
    else printf 'SKIP|%s|%s|%s\n' "$1" "$title" "scripts/$2 is not in this checkout" >>"$PRE"; fi
  }
fi
if [ -n "${PRE:-}" ] && [ -z "${SALU_BOX_TESTS_REEXEC:-}" ]; then
  pre_runner() {
    selected 5.4 || return 0
    [ "$WITH_SUDO" = 1 ] && [ "$WITH_TICKETS" = 1 ] || return 0
    local title P=boxtest-runner SP TF live out n st proof end
    title="$(title_of 5.4)"
    rec() { printf '%s|5.4|%s|%s\n' "$1" "$title" "$(enc "$2")" >>"$PRE"; }
    asalu() { sudo -u "$SALU_USER" -H "$@"; }
    SP="$(asalu sh -c 'command -v salu' 2>/dev/null)"
    [ -n "$SP" ] || { rec SKIP "salu was not found on $SALU_USER's PATH"; return 0; }
    have jq || { rec SKIP "jq is not installed (sudo apt install jq)"; return 0; }
    live="$(asalu "$PODMAN" ps --filter label=salu.kernel=1 --format '{{.Names}}' 2>/dev/null | grep -vE '^salu-k-(boxtest|doctor)' | tr '\n' ' ')"
    if [ -n "$live" ] && [ "${SALU_BOX_TESTS_ALLOW_SWEEP:-}" != 1 ]; then
      rec SKIP "live runner containers are running ($live): the stale-container sweep when a new orchestrator starts can stop them mid-ticket. Set SALU_BOX_TESTS_ALLOW_SWEEP=1 to run anyway (or wait for the sweep fix in #74)."; return 0
    fi
    # the Claude login the runner uses: SALU_BOX_RUNNER_TOKEN_FILE, else the token of an existing runner project
    TF="$(mktemp /tmp/salu-box-runner-token.XXXXXX)"; chmod 600 "$TF"
    if [ -n "${SALU_BOX_RUNNER_TOKEN_FILE:-}" ]; then cat "$SALU_BOX_RUNNER_TOKEN_FILE" >"$TF"
    else sudo sh -c 'cat /etc/salu/*.env 2>/dev/null' | sed -n 's/^CLAUDE_CODE_OAUTH_TOKEN=//p' | head -n 1 >"$TF"; fi
    [ -s "$TF" ] || { rm -f "$TF"; rec SKIP "no Claude token for the runner: set SALU_BOX_RUNNER_TOKEN_FILE, or add a runner project first so its token can be reused"; return 0; }
    sudo env SALU_RUNNER_USER="$SALU_USER" "$SP" runner remove "$P" --purge --yes >/dev/null 2>&1 # a leftover from an earlier run
    out="$(sudo env SALU_RUNNER_USER="$SALU_USER" "$SP" runner add "$P" --token-file "$TF" --no-sync 2>&1)"; rc=$?
    rm -f "$TF"
    if [ $rc -ne 0 ]; then rec FAIL "salu runner add failed (exit $rc):"$'\n'"$(printf '%s' "$out" | tail -n 6)"; return 0; fi
    # optional: put the container login where the runner reads it, to test the unit apart from the login location
    [ "${SALU_BOX_RUNNER_KERNEL_TOKEN:-}" = copy ] && [ -f "$(getent passwd "$SALU_USER" | cut -d: -f6)/.salu/kernel-token" ] && sudo install -o "$SALU_USER" -m 600 "$(getent passwd "$SALU_USER" | cut -d: -f6)/.salu/kernel-token" "/var/lib/salu/$P/kernel-token"
    asalu env SALU_HOME="/var/lib/salu/$P" "$SP" add "runner kernel check" "In /work, run: id -u; hostname; uname -r and write their output unchanged to proof.txt, then stop." "model=haiku effort=low" --project "$P" >/dev/null 2>&1
    end=$((SECONDS + 420)); st=""
    while [ $SECONDS -lt $end ]; do
      st="$(asalu env SALU_HOME="/var/lib/salu/$P" "$SP" list --json 2>/dev/null | jq -r '[.[].status] | join(",")' 2>/dev/null)"
      case "$st" in done|failed|blocked) break ;; esac
      sleep 5
    done
    proof="/var/lib/salu/$P/kernel/$P/proof.txt"
    n="$(sudo cat "$proof" 2>/dev/null)"
    if [ "$st" = done ] && printf '%s' "$n" | grep -q 'salu-kernel'; then
      rec PASS "ran through salu-runner@$P ($(systemctl is-active "salu-runner@$P" 2>/dev/null)); proof.txt shows the container:"$'\n'"$(printf '%s' "$n" | head -n 3)"
    else
      rec FAIL "ticket status '${st:-none}'; proof.txt: ${n:-missing}"$'\n'"$(asalu env SALU_HOME="/var/lib/salu/$P" "$SP" list --json 2>/dev/null | jq -r '.[0].error // empty' | head -n 3)"$'\n'"$(sudo journalctl -u "salu-runner@$P" -n 12 --no-pager 2>&1 | tail -n 12)"
    fi
    sudo env SALU_RUNNER_USER="$SALU_USER" "$SP" runner remove "$P" --purge --yes >/dev/null 2>&1
    asalu "$PODMAN" rm -f "salu-k-$P" >/dev/null 2>&1
  }
  pre_runner
  pre_check 1.1 install-box.sh; pre_check 2.1 install-kernel-runtime.sh --user "$SALU_USER" # else it checks the user who ran sudo
  chmod 644 "$PRE"
  COPY="$(mktemp /tmp/salu-box-tests-run.XXXXXX)"; cp "${BASH_SOURCE[0]}" "$COPY"; chmod 755 "$COPY"
  echo "running the tests as the $SALU_USER user (sudo -u $SALU_USER -H)"
  sudo -u "$SALU_USER" -H env SALU="$SALU" SALU_CONTAINER_ENGINE="${SALU_CONTAINER_ENGINE:-}" SALU_BOX_TESTS_REEXEC=1 SALU_BOX_TESTS_PRE="$PRE" SALU_BOX_TESTS_HERE="$HERE" bash "$COPY" "${ORIG_ARGS[@]}"
  rc=$?; rm -f "$COPY" "$PRE"; exit $rc
fi
if [ -n "${SALU_BOX_TESTS_REEXEC:-}" ] && [ -s "${PRE:-/nonexistent}" ]; then
  while IFS='|' read -r st id title ev; do record "$st" "$id" "$title" "$(printf '%s' "$ev" | tr '\037' '\n')"; done <"$PRE"
fi

echo "salu box tests  $(date -u +%FT%TZ)  host $(hostname)  $(uname -sr)"
have "$SALU" || { echo "salu is not installed or not on PATH (set SALU=/path/to/salu)" >&2; exit 2; }
echo "salu: $("$SALU" --version 2>&1 | head -1)"

# --- 1. box setup and health -------------------------------------------------------------------------------------
if run_ok 1.1; then
  if [ -x "$HERE/install-box.sh" ]; then
    out="$(sudo "$HERE/install-box.sh" --check 2>&1)"; rc=$?
    if [ $rc -eq 0 ] && ! printf '%s' "$out" | grep -q '✗'; then pass 1.1 "$(title_of 1.1)" "$(printf '%s' "$out" | tail -n 6)"; else fail 1.1 "$(title_of 1.1)" "exit $rc"$'\n'"$(printf '%s' "$out" | grep -iv '^ok' | tail -n 10)"; fi
  else skip 1.1 "$(title_of 1.1)" "scripts/install-box.sh is not in this checkout (PR #73 not merged here)"; fi
fi
if selected 1.3; then
  if have sensors; then manual 1.3 "$(title_of 1.3) — read this while tickets run: CPU under about 85 C, no throttling" "$(sensors 2>&1 | grep -iE 'package|core 0|Tctl|fan' | head -n 6)"
  else manual 1.3 "$(title_of 1.3) — install lm-sensors (sudo apt install lm-sensors), run sensors under load"; fi
fi
selected 1.2 && manual 1.2 "$(title_of 1.2) — reboot, wait two minutes, run: salu runner list (every project runner active)"
if run_ok 1.4; then
  if have ss; then
    addrs="$(ss -H -tlnp 2>/dev/null | awk '{print $4}' | grep -vE '^(127\.|\[::1\]|\[?::1\]?:|127\.0\.0\.53)')"
    # Tailscale's peer API listens on the box's tailnet address only: reachable from your own devices, not the LAN or the internet
    TAILNET='^(100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9.]+|\[fd7a:115c:a1e0:[0-9a-f:]*\]):[0-9]+$'
    tailnet="$(printf '%s\n' "$addrs" | grep -E "$TAILNET" | tr '\n' ' ')"
    open="$(printf '%s\n' "$addrs" | grep -vE "$TAILNET" | grep . | sed -E 's/.*:([0-9]+)$/\1/' | sort -un | tr '\n' ' ')"
    extra="$(for p in $open; do [ "$p" = 22 ] || printf '%s ' "$p"; done)"
    if [ -z "$extra" ]; then pass 1.4 "$(title_of 1.4)" "listening beyond loopback: ${open:-nothing}${tailnet:+; tailnet only (Tailscale): ${tailnet% }}. Still check from another machine: nmap -Pn <box-ip>"
    else fail 1.4 "$(title_of 1.4)" "also listening beyond loopback: $extra"$'\n'"$(ss -H -tlnp 2>/dev/null | head -n 8)"; fi
  else skip 1.4 "$(title_of 1.4)" "ss not found"; fi
fi

# --- 2. kernel v2 ---------------------------------------------------------------------------------------------
if run_ok 2.1; then
  if [ -x "$HERE/install-kernel-runtime.sh" ]; then
    out="$(sudo "$HERE/install-kernel-runtime.sh" --check --user "$(id -un)" 2>&1)"; rc=$?
    if [ $rc -eq 0 ]; then pass 2.1 "$(title_of 2.1)" "$(printf '%s' "$out" | tail -n 8)"; else fail 2.1 "$(title_of 2.1)" "$(printf '%s' "$out" | grep -v '^ok' | tail -n 10)"; fi
  else skip 2.1 "$(title_of 2.1)" "scripts/install-kernel-runtime.sh not found"; fi
fi

STATUS_OUT="$("$SALU" kernel status 2>&1)"; STATUS_RC=$?
CONTAINER_READY=0; [ $STATUS_RC -eq 0 ] && CONTAINER_READY=1
need_container() { # id: skip with the reason when there is no ready container kernel
  [ $CONTAINER_READY = 1 ] && return 0
  skip "$1" "$(title_of "$1")" "container kernel not ready: $(printf '%s' "$STATUS_OUT" | grep -E '✗|not|no ' | head -n 3)"
  return 1
}

if run_ok 2.3 && need_container 2.3; then
  out="$("$SALU" doctor --sandbox 2>&1)"; rc=$?
  DOCTOR_OUT="$out"
  if [ $rc -eq 0 ]; then pass 2.3 "$(title_of 2.3)" "$(printf '%s' "$out" | grep -E 'container:' | head -n 6)"
  else fail 2.3 "$(title_of 2.3)" "$(printf '%s' "$out" | grep -E '✗|problem' | head -n 10)"; fi
fi
DOCTOR_OUT="${DOCTOR_OUT:-}"
doctor_line() { printf '%s\n' "$DOCTOR_OUT" | grep -F "$1" | head -n 1; }
if run_ok 3.2; then
  need_container 3.2 && {
    [ -n "$DOCTOR_OUT" ] || DOCTOR_OUT="$("$SALU" doctor --sandbox 2>&1)"
    l="$(doctor_line 'refuses private, loopback and cloud-metadata')"
    if printf '%s' "$l" | grep -q '✓'; then pass 3.2 "$(title_of 3.2)" "$l"; else fail 3.2 "$(title_of 3.2)" "${l:-the doctor did not report the egress check}"; fi
  }
fi
if run_ok 3.3; then
  need_container 3.3 && {
    [ -n "$DOCTOR_OUT" ] || DOCTOR_OUT="$("$SALU" doctor --sandbox 2>&1)"
    l="$(doctor_line 'only web ports')"
    if printf '%s' "$l" | grep -q '✓'; then pass 3.3 "$(title_of 3.3)" "$l"; else fail 3.3 "$(title_of 3.3)" "${l:-the doctor did not report the port check}"; fi
  }
fi

if run_ok 2.4; then
  out="$(SALU_CONTAINER_ENGINE=/nonexistent/podman SALU_KERNEL_REQUIRE=1 "$SALU" kernel status 2>&1)"; rc=$?
  # With the container kernel required and Podman missing the status must say tickets FAIL, never "weaker fence".
  if [ $rc -ne 0 ] && printf '%s' "$out" | grep -q 'will FAIL'; then pass 2.4 "$(title_of 2.4)" "$(printf '%s' "$out" | grep 'will FAIL' | head -n 1)"
  else fail 2.4 "$(title_of 2.4)" "exit $rc"$'\n'"$(printf '%s' "$out" | head -n 8)"; fi
fi

if run_ok 4.2; then
  need_container 4.2 && {
    out="$("$SALU" kernel bench 2>&1)"; rc=$?
    if [ $rc -eq 0 ] && printf '%s' "$out" | grep -q 's$\|[0-9] s'; then pass 4.2 "$(title_of 4.2)" "$(printf '%s' "$out" | grep -E '✓|✗')"
    else fail 4.2 "$(title_of 4.2)" "exit $rc"$'\n'"$(printf '%s' "$out" | head -n 8)"; fi
  }
fi
if run_ok 4.7; then
  out="$("$SALU" kernel platform 2>&1)"; rc=$?
  if [ $rc -eq 0 ] && printf '%s' "$out" | grep -q 'gVisor platform'; then pass 4.7 "$(title_of 4.7)" "$out"$'\n'"(change with: salu kernel platform systrap|kvm, then rerun 4.2 to compare)"
  else fail 4.7 "$(title_of 4.7)" "exit $rc: $out"; fi
fi

if run_ok 5.1; then
  if printf '%s' "$STATUS_OUT" | grep -q 'agents have a Claude login of their own'; then pass 5.1 "$(title_of 5.1)" "$(printf '%s' "$STATUS_OUT" | grep 'login of their own')"
  else fail 5.1 "$(title_of 5.1)" "no kernel login: claude setup-token, then salu kernel login"; fi
fi
if run_ok 6.3; then
  out="$("$SALU" remote ntfy --test 2>&1)"; rc=$?
  if [ $rc -eq 0 ]; then pass 6.3 "$(title_of 6.3)" "$out"$'\n'"Now check your phone: the test notification must have arrived."
  else fail 6.3 "$(title_of 6.3)" "exit $rc: $out"; fi
fi

# --- tickets: small real runs in an isolated salu home --------------------------------------------------------------
# Own SALU_HOME, own orchestrator, three throwaway projects. Nothing here touches your real projects or tickets.
# The container login (kernel token) is copied in; the projects' containers are removed at the end.
WORK=""; ORCH_ENV=()
ticket_tests_wanted() {
  [ "$WITH_TICKETS" = 1 ] || return 1
  local id; for id in 2.2 2.5 2.6 2.7 3.1 4.1 4.3 4.4 4.5 4.6 4.8; do selected "$id" && return 0; done
  return 1
}
S() { SALU_HOME="$WORK/home" SALU_KERNEL_REQUIRE=1 "$SALU" "$@"; }
cleanup() {
  [ -n "$WORK" ] || return 0
  SALU_HOME="$WORK/home" "$SALU" stop >/dev/null 2>&1
  if have "$PODMAN"; then for c in $("$PODMAN" ps -a --filter label=salu.kernel=1 --format '{{.Names}}' 2>/dev/null | grep '^salu-k-boxtest'); do "$PODMAN" rm -f "$c" >/dev/null 2>&1; done; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

wait_idle() { # seconds: wait until no ticket is queued or running in the test home
  local end=$((SECONDS + $1)) n
  while [ $SECONDS -lt $end ]; do
    n="$(S list --json 2>/dev/null | jq '[.[] | select(.status=="todo" or .status=="running")] | length' 2>/dev/null)"
    [ "${n:-1}" = 0 ] && return 0
    sleep 3
  done
  return 1
}
tstatus() { S list "$1" --json 2>/dev/null | jq -r '[.[].status] | join(",")' 2>/dev/null; }
add_ticket() { # project name query
  S add "$2" "$3" "model=haiku effort=low" --project "$1" >/dev/null 2>&1
}
kdir() { echo "$WORK/home/kernel/$1"; }
start_orch() { # extra env assignments as args
  env "$@" SALU_HOME="$WORK/home" SALU_KERNEL_REQUIRE=1 "$SALU" run --detach --no-queue >/dev/null 2>&1
  sleep 4
}
restart_orch() { S stop >/dev/null 2>&1; sleep 2; start_orch "$@"; }

if ticket_tests_wanted; then
  echo; echo "${D}ticket tests: isolated home, small haiku tickets, projects boxtest-a/b/c${N}"
  if ! have jq; then
    for id in 2.2 2.5 2.6 2.7 3.1 4.1 4.3 4.4 4.5 4.6 4.8; do selected "$id" && skip "$id" "$(title_of $id)" "jq is not installed (sudo apt install jq)"; done
  elif [ -n "$("$PODMAN" ps --filter label=salu.kernel=1 --format '{{.Names}}' 2>/dev/null | grep -vE '^salu-k-(boxtest|doctor)')" ] && [ "${SALU_BOX_TESTS_ALLOW_SWEEP:-}" != 1 ]; then
    for id in 2.2 2.5 2.6 2.7 3.1 4.1 4.3 4.4 4.5 4.6 4.8; do selected "$id" && skip "$id" "$(title_of $id)" "live runner containers are running; the test orchestrator's stale-container sweep can stop them mid-ticket. Set SALU_BOX_TESTS_ALLOW_SWEEP=1 to run anyway."; done
  elif [ $CONTAINER_READY != 1 ]; then
    for id in 2.2 2.5 2.6 2.7 3.1 4.1 4.3 4.4 4.5 4.6 4.8; do selected "$id" && need_container "$id"; done
  else
    WORK="$(mktemp -d "${TMPDIR:-/tmp}/salu-box-tests.XXXXXX")"
    mkdir -p "$WORK/home"
    [ -f "$HOME/.salu/kernel-token" ] && install -m 600 "$HOME/.salu/kernel-token" "$WORK/home/kernel-token"
    for p in a b c; do mkdir -p "$WORK/proj-$p" && S add project "boxtest-$p" "$WORK/proj-$p" >/dev/null 2>&1; done
    start_orch SALU_KERNEL_IDLE_MINUTES=0 SALU_KERNEL_DISK_GB=1
    STARTS="$WORK/home/logs/kernel-starts.jsonl"
    PKG=sl   # a tiny package that is not in the image

    # 2.2 / 3.1 / 2.5: one project, one ticket that checks the container from inside
    if selected 2.2 || selected 3.1 || selected 2.5; then
      add_ticket boxtest-a "kernel check" "In /work, run these shell commands exactly and write their output, unchanged, to proof.txt, then stop. Do not do anything else. (1) id -u; hostname; uname -r (2) curl -s -o /dev/null -w 'WEB %{http_code}\n' https://example.com/ (3) apt-get update -qq && apt-get install -y -qq $PKG && dpkg -s $PKG | grep -E '^Status' (4) ls /home /root | head -n 20"
      wait_idle 420 || true
      P="$(kdir boxtest-a)/proof.txt"
      st="$(tstatus boxtest-a)"
      if selected 2.2; then
        if [ "$st" = done ] && [ -s "$P" ] && grep -q 'salu-kernel' "$P"; then pass 2.2 "$(title_of 2.2)" "ticket $st; proof.txt shows the container hostname:"$'\n'"$(head -n 3 "$P")"
        elif [ -s "$P" ] && [ "$(head -n 1 "$P")" = 0 ]; then pass 2.2 "$(title_of 2.2)" "ticket $st; ran as root in a container (uid 0)"
        else fail 2.2 "$(title_of 2.2)" "ticket $st"$'\n'"$(S log boxtest-a 2>&1 | tail -n 6)"; fi
      fi
      if selected 3.1; then
        if grep -qE '^WEB (200|301|302)' "$P" 2>/dev/null; then pass 3.1 "$(title_of 3.1)" "$(grep '^WEB' "$P")"; else fail 3.1 "$(title_of 3.1)" "$(grep '^WEB' "$P" 2>/dev/null || echo 'no WEB line in proof.txt')"; fi
      fi
      if selected 2.5; then
        if grep -q 'install ok installed' "$P" 2>/dev/null && ! dpkg -s "$PKG" >/dev/null 2>&1; then pass 2.5 "$(title_of 2.5)" "$PKG installed in the container, not on the host (dpkg -s on the host: not installed)"
        elif dpkg -s "$PKG" >/dev/null 2>&1; then fail 2.5 "$(title_of 2.5)" "$PKG is installed on the HOST"
        else fail 2.5 "$(title_of 2.5)" "install did not complete: $(grep -E 'Status|E:' "$P" 2>/dev/null | head -n 2)"; fi
      fi
    fi

    # 2.6: a second project must not see the first one's files or packages
    if selected 2.6; then
      echo secret-from-a > "$(kdir boxtest-a)/only-in-a.txt" 2>/dev/null
      add_ticket boxtest-b "isolation check" "In /work, write to proof.txt the output of: ls -la /work; ls /work/../ ; dpkg -s $PKG 2>&1 | grep -E '^Status|not installed'; find / -name only-in-a.txt -not -path '/proc/*' 2>/dev/null | head. Put each command's output under a header line, and write 'none' where a command prints nothing. Then stop."
      wait_idle 420 || true
      Pb="$(kdir boxtest-b)/proof.txt"
      if [ -s "$Pb" ] && ! grep -qE '^/[^ ]*only-in-a\.txt$' "$Pb" && ! grep -q '^Status: install ok installed' "$Pb"; then pass 2.6 "$(title_of 2.6)" "project b saw neither project a's file nor its installed package"
      else fail 2.6 "$(title_of 2.6)" "$( [ -s "$Pb" ] && { grep -nE 'only-in-a|install ok' "$Pb" | head -n 8; } || echo 'no proof.txt')"; fi
    fi

    # 4.3 / 4.4 / 4.5 / 4.6: idle unload with SALU_KERNEL_IDLE_MINUTES=0 (set above): stop right after the ticket, restart on the next
    if selected 4.3 || selected 4.4 || selected 4.5 || selected 4.6; then
      add_ticket boxtest-c "leave a process" "Run: nohup sleep 3601 >/dev/null 2>&1 & then write 'started' to proof.txt in /work, and stop."
      wait_idle 300 || true
      sleep 12
      running="$("$PODMAN" ps --filter label=salu.kernel=1 --format '{{.Names}}' 2>/dev/null | grep '^salu-k-boxtest-c' || true)"
      host_sleep="$(pgrep -f 'sleep 3601' || true)"
      n1="$( [ -f "$STARTS" ] && wc -l < "$STARTS" || echo 0)"
      selected 4.4 && { if [ -z "$running" ]; then pass 4.4 "$(title_of 4.4)" "no container for boxtest-c ~12 s after its ticket ended (SALU_KERNEL_IDLE_MINUTES=0)"; else fail 4.4 "$(title_of 4.4)" "still running: $running"; fi; }
      selected 4.5 && { if [ -z "$host_sleep" ]; then pass 4.5 "$(title_of 4.5)" "the background sleep is gone after the stop (pgrep finds nothing)"; else fail 4.5 "$(title_of 4.5)" "sleep 3601 still running on the host: pid $host_sleep"; fi; }
      add_ticket boxtest-c "restart check" "Write the output of 'ls /work' to proof2.txt in /work, and stop."
      wait_idle 300 || true
      n2="$( [ -f "$STARTS" ] && wc -l < "$STARTS" || echo 0)"
      if selected 4.3; then
        if [ -s "$(kdir boxtest-c)/proof2.txt" ] && [ "$n2" -gt "$n1" ]; then pass 4.3 "$(title_of 4.3)" "the next ticket started the stopped container again (starts logged: $n1 -> $n2)"
        else fail 4.3 "$(title_of 4.3)" "ticket status: $(tstatus boxtest-c); starts logged $n1 -> $n2"; fi
      fi
      if selected 4.6; then
        sl="$(S kernel status 2>&1 | grep 'start time over')"
        if [ -s "$STARTS" ] && jq -e '.ms and .project and .platform' "$STARTS" >/dev/null 2>&1 && [ -n "$sl" ]; then
          pass 4.6 "$(title_of 4.6)" "$sl"$'\n'"$(jq -r '"\(.project) \(.kind) \(.ms) ms \(.platform)"' "$STARTS" | tail -n 4)"$'\n'"Compare with the 1-3 s estimate."
        else fail 4.6 "$(title_of 4.6)" "log missing or salu kernel shows no start times: ${sl:-nothing}"; fi
      fi
    fi

    # 2.7: a project over its disk limit (SALU_KERNEL_DISK_GB=1 above) must be refused before its next ticket
    if selected 2.7; then
      fallocate -l 1500M "$(kdir boxtest-a)/big.bin" 2>/dev/null || head -c 1500000000 /dev/zero > "$(kdir boxtest-a)/big.bin"
      add_ticket boxtest-a "over the limit" "Write 'ran' to proof3.txt in /work."
      wait_idle 120 || true
      err="$(S list boxtest-a --json 2>/dev/null | jq -r '[.[] | select(.name=="over the limit")][0] | "\(.status) \(.error // "")"')"
      if [ ! -e "$(kdir boxtest-a)/proof3.txt" ] && printf '%s' "$err" | grep -qiE 'limit|GB'; then pass 2.7 "$(title_of 2.7)" "refused: $err"
      else fail 2.7 "$(title_of 2.7)" "ticket: $err; proof3.txt exists: $([ -e "$(kdir boxtest-a)/proof3.txt" ] && echo yes || echo no)"; fi
      rm -f "$(kdir boxtest-a)/big.bin" "$(kdir boxtest-a)/proof3.txt"
    fi

    # 4.1 / 4.8: many tickets in 3 projects at once, with the box ceiling set to 3 so a wait must happen.
    # Samples containers, slot files and the wait reason `salu kernel status` gives while they run.
    if selected 4.1 || selected 4.8; then
      default_line="$(SALU_BOX_SLOTS_DIR="$WORK/slots" "$SALU" kernel status 2>&1 | grep -E 'tickets running on this box')"
      LIM=3
      restart_orch SALU_KERNEL_IDLE_MINUTES=0 SALU_BOX_SLOTS_DIR="$WORK/slots" SALU_BOX_CONCURRENCY=$LIM
      for i in 1 2 3; do for p in a b c; do add_ticket "boxtest-$p" "load $p$i" "Run 'sleep 45', then write done to load-$p$i.txt in /work. Nothing else."; done; done
      maxc=0; maxslots=0; sawwhy=""; end=$((SECONDS + 900))
      while [ $SECONDS -lt $end ]; do
        c="$("$PODMAN" ps --filter label=salu.kernel=1 --format '{{.Names}}' 2>/dev/null | grep -c '^salu-k-boxtest')"
        s="$(ls "$WORK/slots" 2>/dev/null | wc -l)"
        [ "$c" -gt "$maxc" ] && maxc=$c
        [ "$s" -gt "$maxslots" ] && maxslots=$s
        w="$(SALU_BOX_SLOTS_DIR="$WORK/slots" SALU_BOX_CONCURRENCY=$LIM "$SALU" kernel status 2>&1 | grep -E 'the next one waits')"
        [ -n "$w" ] && sawwhy="$w"
        n="$(S list --json 2>/dev/null | jq '[.[] | select(.status=="todo" or .status=="running")] | length' 2>/dev/null)"
        [ "${n:-1}" = 0 ] && break
        sleep 2
      done
      left="$(ls "$WORK/slots" 2>/dev/null | wc -l)"
      mem="$(awk '/MemTotal/{printf "%.1f", $2/1048576}' /proc/meminfo)"
      doneN="$(S list --json 2>/dev/null | jq '[.[] | select(.status=="done" and (.name|startswith("load")))] | length')"
      if selected 4.1; then
        ev="machine memory ${mem} GiB; with the ceiling set to $LIM: most containers at once $maxc, most slot files at once $maxslots, load tickets done $doneN of 9"$'
'"default state before the load: ${default_line:-(not shown)}"$'
'"wait reason seen: ${sawwhy:-none}"
        if [ "$doneN" = 9 ] && [ "$maxc" -le "$LIM" ] && [ -n "$sawwhy" ]; then pass 4.1 "$(title_of 4.1)" "$ev"; else fail 4.1 "$(title_of 4.1)" "$ev"; fi
      fi
      if selected 4.8; then
        if [ "$maxslots" -le "$LIM" ] && [ "$maxslots" -ge 1 ] && [ "$left" = 0 ] && [ "$doneN" = 9 ]; then pass 4.8 "$(title_of 4.8)" "never more than $maxslots slot files (ceiling $LIM); $left left after everything finished; $doneN tickets ran"
        else fail 4.8 "$(title_of 4.8)" "max slots $maxslots (ceiling $LIM), left behind $left, tickets done $doneN of 9"; fi
      fi
    fi
  fi
fi

# --- anything selected but not covered above: not run ---------------------------------------------------------------
for id in $(printf '%s\n' "$TESTS" | cut -d'|' -f1); do
  selected "$id" || continue
  have_result=0; for r in "${RESULTS[@]}"; do rest="${r#*|}"; [ "${rest%%|*}" = "$id" ] && have_result=1; done
  [ $have_result = 1 ] && continue
  case "$(kind_of "$id")" in
    manual) manual "$id" "$(title_of "$id")" ;;
    tickets) skip "$id" "$(title_of "$id")" "needs --tickets" ;;
    sudo) skip "$id" "$(title_of "$id")" "needs --sudo" ;;
    runner) skip "$id" "$(title_of "$id")" "needs --sudo and --tickets, and the salu user from the box installer" ;;
    *) skip "$id" "$(title_of "$id")" "not run" ;;
  esac
done

# --- summary ----------------------------------------------------------------------------------------------------------
np=0; nf=0; ns=0; nm=0
for r in "${RESULTS[@]}"; do case "${r%%|*}" in PASS) np=$((np+1)) ;; FAIL) nf=$((nf+1)) ;; SKIP) ns=$((ns+1)) ;; MANUAL) nm=$((nm+1)) ;; esac; done
{
  echo
  echo "=== salu box tests: summary  $(date -u +%FT%TZ)  $(hostname)  salu $("$SALU" --version 2>&1 | head -1) ==="
  echo "memory $(awk '/MemTotal/{printf "%.1f GiB", $2/1048576}' /proc/meminfo)  cpu $(grep -m1 'model name' /proc/cpuinfo | sed 's/.*: //')"
  for r in "${RESULTS[@]}"; do IFS='|' read -r st id title ev <<<"$r"; printf '%-6s %-4s %s\n' "$st" "$id" "$title"; done | sort -k2,2V
  echo "passed $np, failed $nf, not run $ns, for you to do $nm"
  echo "evidence:"
  for r in "${RESULTS[@]}"; do
    st="${r%%|*}"; rest="${r#*|}"; id="${rest%%|*}"; rest="${rest#*|}"; ev="${rest#*|}"
    { [ "$st" = PASS ] || [ "$st" = FAIL ]; } || continue
    printf '[%s %s]\n%s\n' "$st" "$id" "$ev"
  done
} | tee "$REPORT"
echo; echo "saved to $REPORT"
[ "$nf" = 0 ]
