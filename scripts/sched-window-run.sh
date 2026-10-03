#!/usr/bin/env bash
# A real-window proof of the token-aware scheduler's enforce mode ("salu sched on"). Run it on the box, as yourself:
#
#   bash scripts/sched-window-run.sh          3 small real tickets (haiku, low effort) in a throwaway salu home
#
# It uses a scratch SALU_HOME and scratch git folder, so your projects and queues are never touched, and it
# deletes them at the end. The real meter is read each step. Steps:
#   1 read the real 5-hour and weekly meter
#   2 run 3 tiny tickets one at a time with the scheduler ON; note how far the 5-hour meter moved for each
#   3 hold test: the margin is set to 100 so nothing fits; a ticket must STAY queued and `salu sched` must name the reset
#   4 release test: margin back to normal; the same ticket must start and finish
# Everything is saved to ~/sched-window-run-<time>.txt: paste it back.
set -uo pipefail
SALU_USER="${SALU_BOX_USER:-salu}"
if [ "$(id -un)" != "$SALU_USER" ] && [ -z "${SCHED_RUN_REEXEC:-}" ]; then
  COPY="$(mktemp /tmp/sched-window-run.XXXXXX)"; cp "$0" "$COPY"; chmod 644 "$COPY"
  TMPOUT="/tmp/sched-window-run-$(date +%Y%m%d-%H%M%S).txt"; FINAL="$HOME/$(basename "$TMPOUT")"
  echo "running as the $SALU_USER user (sudo -u $SALU_USER -H)"
  sudo -u "$SALU_USER" -H env SALU="${SALU:-salu}" SCHED_RUN_REEXEC=1 SCHED_RUN_OUT="$TMPOUT" bash "$COPY"
  rc=$?; rm -f "$COPY"
  [ -f "$TMPOUT" ] && cp "$TMPOUT" "$FINAL" && echo "report copied to $FINAL"
  exit $rc
fi
SALU="${SALU:-salu}"
OUT="${SCHED_RUN_OUT:-/tmp/sched-window-run-$(date +%Y%m%d-%H%M%S).txt}"; chmod 644 "$OUT" 2>/dev/null; : >>"$OUT"; chmod 644 "$OUT"
SCRATCH="$(mktemp -d /tmp/sched-run.XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT
export SALU_HOME="$SCRATCH/home" SALU_SCHED=on
mkdir -p "$SALU_HOME" "$SCRATCH/proj"
git -C "$SCRATCH/proj" init -q && git -C "$SCRATCH/proj" -c user.name=s -c user.email=s@s commit -q --allow-empty -m init
# The box login the runner units read (box-login.env, or the kernel-token file); without it the meter has no login.
ROOT="${SALU_RUNNER_ROOT:-/var/lib/salu}"
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  if [ -r "$ROOT/box-login.env" ]; then set -a; . "$ROOT/box-login.env"; set +a
  elif [ -r "$ROOT/kernel-token" ]; then CLAUDE_CODE_OAUTH_TOKEN="$(tr -d '\n' <"$ROOT/kernel-token")"; export CLAUDE_CODE_OAUTH_TOKEN; fi
fi
FAILS=0
say() { printf '%s\n' "$*" | tee -a "$OUT"; }
ok() { say "PASS  $*"; }
bad() { say "FAIL  $*"; FAILS=$((FAILS + 1)); }
usage_line() { "$SALU" usage --refresh --json 2>/dev/null | jq -r '. as $u | ([.windows[]|select(.id=="session" or .id=="weekly")|"\(.id)=\(.percentUsed)%"]|join(" ")) + " plan=" + ($u.plan//"?") + " available=" + ($u.available|tostring)'; }
sess() { "$SALU" usage --refresh --json 2>/dev/null | jq -r '(.windows[]|select(.id=="session")|.percentUsed)//"none"'; }
resets() { "$SALU" usage --json 2>/dev/null | jq -r '(.windows[]|select(.id=="session")|.resetsAt)//"none"'; }
status_of() { "$SALU" list --json 2>/dev/null | jq -r --arg n "$1" '[.[]|select(.name==$n)|.status][0]//"?"'; }
# Run the orchestrator until ticket $1 is done/failed or $2 seconds pass, then stop it. Log goes to $3.
run_until() {
  "$SALU" run --plain --concurrency 1 >"$3" 2>&1 & local pid=$! i=0
  while [ "$i" -lt "$2" ]; do
    sleep 2; i=$((i + 2))
    case "$(status_of "$1")" in done|failed|blocked) sleep 3; break ;; esac
    kill -0 "$pid" 2>/dev/null || break
  done
  kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; return 0
}
say "salu sched window run  $(date -Is)  $($SALU --version 2>&1 | head -1)"
say "scratch home $SALU_HOME (deleted at the end)"

say "== 1 meter"
M0="$(usage_line)"; say "$M0"
RESET="$(resets)"; say "5-hour window resets at epoch ms $RESET"
case "$M0" in *available=true*) ok "the meter reads from this login" ;;
  *) say "NOTE  no meter yet: $("$SALU" usage --json 2>/dev/null | jq -rc '[.reasonKind,.reason,.error]|map(select(.))|join(" | ")')"
     say "      (a token from claude setup-token may not be allowed to read usage; the first ticket's own rate-limit events may still fill it)" ;;
esac

"$SALU" add project scratch "$SCRATCH/proj" --model haiku --effort low --default >/dev/null 2>&1
"$SALU" sched on >/dev/null

say "== 2 three tiny tickets, one at a time, scheduler on"
for i in 1 2 3; do
  B="$(sess)"
  "$SALU" add "probe$i" "Reply with the single word OK. Do not use any tools or change any files." >/dev/null 2>&1
  run_until "probe$i" 300 "$SCRATCH/run$i.log"
  sleep 5
  A="$(sess)"
  S="$(status_of "probe$i")"
  say "probe$i status=$S 5h meter $B% -> $A%"
  [ "$S" = "done" ] && ok "probe$i ran to the end" || bad "probe$i is $S (see below)"
done
case "$(usage_line)" in *available=true*) ok "the meter is readable after the probes" ;;
  *) bad "no meter even after real runs: the box login cannot read plan usage, so enforce has nothing to enforce on"; say "wrote $OUT"; exit 1 ;; esac
say "learned (salu sched):"; "$SALU" sched 2>&1 | head -8 | sed 's/^/    /' | tee -a "$OUT" >/dev/null

say "== 3 hold test (SALU_SCHED_MARGIN=100: nothing may start)"
"$SALU" add holdme "Reply with the single word OK. Do not use any tools." >/dev/null 2>&1
SALU_SCHED_MARGIN=100 run_until holdme 40 "$SCRATCH/hold.log"
S="$(status_of holdme)"
[ "$S" = "todo" ] && ok "holdme stayed queued (status $S)" || bad "holdme is $S, expected todo"
grep -i "holding the queue" "$SCRATCH/hold.log" | head -2 | tee -a "$OUT" | sed 's/^/    /'
grep -qi "holding the queue until" "$SCRATCH/hold.log" && ok "the log names the reset time" || bad "no 'holding the queue until' line in the log"
SALU_SCHED_MARGIN=100 "$SALU" sched 2>&1 | grep -i "last decision\|waits" | head -3 | sed 's/^/    /' | tee -a "$OUT" >/dev/null

say "== 4 release test (normal margin)"
run_until holdme 300 "$SCRATCH/release.log"
S="$(status_of holdme)"
[ "$S" = "done" ] && ok "holdme started and finished once the margin was back" || bad "holdme is $S, expected done"

say "== end"; say "meter now: $(usage_line)"
say "$([ "$FAILS" -eq 0 ] && echo 'ALL PASS' || echo "$FAILS FAILED")  report saved to $OUT"
[ "$FAILS" -eq 0 ]
