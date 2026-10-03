#!/usr/bin/env bash
# Get the Salu app ready for your own iPhone: finds your Apple team, writes Local.xcconfig
# (not in git) and regenerates the Xcode project. Run it on the Mac, from anywhere:
#   bash ~/salu-ui/ios/device.sh            (or: bash device.sh TEAMID)
# Needs Xcode signed in to your Apple ID (Xcode > Settings > Accounts). A free account works;
# its apps stop opening after 7 days, then run the app from Xcode again.
set -euo pipefail
cd "$(dirname "$0")"

team="${1:-${SALU_TEAM:-}}"
if [ -z "$team" ]; then
  # The team id is the OU of the Apple Development certificates Xcode made.
  # Every unexpired one is read; more than one team means you pick.
  tmp=$(mktemp -d)
  security find-certificate -a -c "Apple Development" -p 2>/dev/null \
    | awk -v d="$tmp" '/BEGIN CERT/{n++} n{print > (d "/c" n)}' || true
  teams=""
  for c in "$tmp"/c*; do
    [ -f "$c" ] || continue
    openssl x509 -in "$c" -noout -checkend 0 >/dev/null 2>&1 || continue
    ou=$(openssl x509 -in "$c" -noout -subject 2>/dev/null \
      | grep -oE 'OU ?= ?[A-Z0-9]{10}' | grep -oE '[A-Z0-9]{10}$' || true)
    [ -n "$ou" ] && teams="$teams $ou"
  done
  rm -rf "$tmp"
  teams=$(echo $teams | tr ' ' '\n' | sort -u | tr '\n' ' ')
  set -- $teams
  if [ $# -gt 1 ]; then
    echo "✗ This Mac has more than one Apple team: $teams"
    echo "  Pick yours: bash device.sh TEAMID"
    exit 1
  fi
  team="${1:-}"
fi
if ! [[ "$team" =~ ^[A-Z0-9]{10}$ ]]; then
  echo "✗ No Apple team found on this Mac."
  echo "  1. Open Xcode > Settings > Accounts, add your Apple ID."
  echo "  2. Select it > Manage Certificates > + > Apple Development."
  echo "  3. Run this again. (Or pass the team id: bash device.sh TEAMID)"
  exit 1
fi

# A bundle id of your own on the phone: Apple gives each id to one team only.
# The simulator keeps dev.salu.phone, so its saved settings stay.
who=$(id -un | tr -cd 'a-zA-Z0-9' | tr 'A-Z' 'a-z')
bundle="dev.salu.phone.${who:-me}"
printf 'SALU_TEAM = %s\nSALU_BUNDLE_ID[sdk=iphoneos*] = %s\n' \
  "$team" "$bundle" > Local.xcconfig
echo "✓ team $team, app id $bundle (Local.xcconfig)"

if ! command -v xcodegen >/dev/null; then
  echo "✗ xcodegen is missing: brew install xcodegen, then run this again"
  exit 1
fi
xcodegen generate --quiet
echo "✓ SaluPhone.xcodeproj is ready"
cat <<'STEPS'

Next, with the iPhone plugged in by cable (say Trust on the phone):
  1. open SaluPhone.xcodeproj, pick your iPhone at the top, ⌘R.
  2. If Xcode asks for Developer Mode, on the iPhone:
     Settings > Privacy & Security > Developer Mode > on.
     It restarts; say Turn On, then ⌘R again.
  3. If the app won't open ("Untrusted Developer"), iPhone:
     Settings > General > VPN & Device Management >
     your Apple ID > Trust. Then ⌘R again.
STEPS
