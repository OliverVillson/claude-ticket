#!/usr/bin/env bash
# Paired setup tests: run on the MAC, after `salu box add user@host`. Checks the control channel and a brand-new
# project end to end (box answers, project made on the box, a ticket runs there and its result comes back).
#
#   scripts/box-paired-tests.sh                one project, one tiny ticket (haiku, a few cents of subscription use)
#   scripts/box-paired-tests.sh --on salubox   pick the box when you have several
#   scripts/box-paired-tests.sh --no-ticket    stop after the project is made (nothing is billed)
#
# Prints PASS / FAIL with evidence for each step, then a summary. Exit status 1 if anything FAILed.
# Status: written against PRs #83 (Mac commands) and #79 (box handlers); not yet run on a real box.
set -uo pipefail
SALU="${SALU:-salu}"; ON=(); TICKET=1
while [ $# -gt 0 ]; do
  case "$1" in
    --on) ON=(--on "$2"); shift 2 ;;
    --no-ticket) TICKET=0; shift ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
NFAIL=0
pass() { printf ' PASS  %s\n' "$1"; }
fail() { printf ' FAIL  %s\n        %s\n' "$1" "${2:-}"; NFAIL=$((NFAIL + 1)); }
check() { # title, command...   (the command's output is the evidence)
  local t="$1"; shift
  local out; out="$("$@" 2>&1)"; local rc=$?
  if [ $rc -eq 0 ]; then pass "$t"; else fail "$t" "$(printf '%s' "$out" | tail -3 | tr '\n' ' ')"; fi
  LAST="$out"
}

P="e2e-$(date +%H%M%S)"
W="$(mktemp -d)"; cd "$W" || exit 2
echo "paired setup tests, project $P, folder $W"

# 1 the box answers (ping and status go over the control repo)
check "1.1 box status" "$SALU" box status ${ON[@]+"${ON[@]}"}
case "$LAST" in *[Dd]octor*|*ok*) pass "1.2 status says something useful" ;; *) fail "1.2 status says something useful" "$LAST" ;; esac

# 2 a brand-new project, in one command
check "2.1 salu new makes the project" "$SALU" new "$P" ${ON[@]+"${ON[@]}"}
[ -d "$W/$P" ] && pass "2.2 the repo is cloned here" || fail "2.2 the repo is cloned here" "no $W/$P"

# 3 a ticket goes to the box and the result comes back
if [ "$TICKET" = 1 ] && cd "$W/$P"; then
  check "3.1 add a ticket" "$SALU" add "say hi" "write the word hi into hi.txt" "model:haiku effort:low"
  got=0
  for i in $(seq 1 60); do
    sleep 5
    if "$SALU" notif --project "$P" --plain 2>/dev/null | grep -qiE "done|finished"; then got=1; break; fi
  done
  [ $got = 1 ] && pass "3.2 the result reached salu notif" || fail "3.2 the result reached salu notif" "nothing after 5 minutes: salu box status; salu notif --project $P"
fi

echo
echo "left behind (remove by hand if you like): GitHub repo $P, folder $W, and the project on the box"
[ $NFAIL -eq 0 ] && echo "all passed" || echo "$NFAIL failed"
exit $((NFAIL > 0))
