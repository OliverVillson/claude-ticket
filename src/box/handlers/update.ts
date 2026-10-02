import { join } from 'node:path';
import { runnerRoot } from '../../core/runner.ts';
import { bad, firstProblem } from './common.ts';
import type { BoxDeps, Handler } from './types.ts';

const VERSION_RE = /^v?\d+\.\d+\.\d+(\.\d+)?$/;
const REPO = 'OliverVillson/salu';

/** The release's installer script: the latest, or a given version. Built here from a validated version, never from a message string. */
export function installerUrl(version?: string): string {
  const base = `https://github.com/${process.env.SALU_REPO || REPO}/releases`;
  if (!version) return `${base}/latest/download/install-box.sh`;
  return `${base}/download/${version.startsWith('v') ? version : 'v' + version}/install-box.sh`;
}

/**
 * Runs inside the transient unit, as root. Downloads the installer and its signature, runs the verify step, and
 * runs the installer ONLY if that passes (fail closed: a missing or failing verify refuses). Why it stopped is written to
 * $SALU_UPDATE_STATUS, which the heartbeat reports. Everything it needs comes in as environment, never from a message string.
 */
export const UPDATE_SCRIPT = `set -u
d=$(mktemp -d) && trap 'rm -rf "$d"' EXIT || exit 1
say() { mkdir -p "$(dirname "$SALU_UPDATE_STATUS")"; printf '%s\\n' "$1" > "$SALU_UPDATE_STATUS"; echo "$1"; }
say "update started"
curl -fsSL --retry 3 -o "$d/install-box.sh" "$SALU_INSTALL_URL" || { say "update refused: could not download the installer"; exit 1; }
curl -fsSL --retry 3 -o "$d/install-box.sh.sig" "$SALU_INSTALL_URL.sig" || { say "update refused: the release has no signature for the installer, so it was not run"; exit 77; }
"$SALU_BIN" release verify "$d/install-box.sh" "$d/install-box.sh.sig" || { say "update refused: the installer's signature did not verify, so it was not run"; exit 77; }
bash "$d/install-box.sh" && say "update finished" || say "update failed: see /var/log/salu-install.log"
`;

export const updateStatusFile = () => join(runnerRoot(), 'box', 'update-status');

/**
 * `update`: hand off to the box installer from the release, after its signature verifies (`salu release verify`). It installs the binary, rebuilds the kernel image only when
 * its recipe changed, recycles old containers and restarts salu-control itself. So it must not run inside this process
 * (it would kill the handler mid-update): it starts in its own transient systemd unit and this answers at once.
 * The installer holds a lock and logs to /var/log/salu-install.log; a second update while one runs just waits for it.
 */
export const update = (deps: BoxDeps): Handler => async ({ args }) => {
  const want = args?.version === undefined ? undefined : String(args.version);
  if (want !== undefined && !VERSION_RE.test(want)) return bad('the version looks like v1.2.3');
  const unit = `salu-update-${Math.floor(deps.now() / 1000)}`;
  const r = await deps.run([
    'systemd-run', '--no-block', '--collect', `--unit=${unit}`, `--setenv=SALU_INSTALL_URL=${installerUrl(want)}`, `--setenv=SALU_BIN=${deps.salu}`, `--setenv=SALU_UPDATE_STATUS=${updateStatusFile()}`,
    ...(want ? [`--setenv=SALU_VERSION=${want.startsWith('v') ? want : 'v' + want}`] : []),
    'bash', '-c', UPDATE_SCRIPT,
  ]);
  if (!r.ok) return bad(`could not start the update: ${firstProblem(r.out)}`);
  return { ok: true, message: `the update to ${want ?? 'the latest release'} is running on the box (log: /var/log/salu-install.log); it restarts the control service when it is done, so ask for status in a few minutes`, data: { unit, version: want ?? 'latest' } };
};
