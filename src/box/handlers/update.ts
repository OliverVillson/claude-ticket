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
 * `update`: hand off to the box installer from the release. It installs the binary, rebuilds the kernel image only when
 * its recipe changed, recycles old containers and restarts salu-control itself. So it must not run inside this process
 * (it would kill the handler mid-update): it starts in its own transient systemd unit and this answers at once.
 * The installer holds a lock and logs to /var/log/salu-install.log; a second update while one runs just waits for it.
 */
export const update = (deps: BoxDeps): Handler => async ({ args }) => {
  const want = args?.version === undefined ? undefined : String(args.version);
  if (want !== undefined && !VERSION_RE.test(want)) return bad('the version looks like v1.2.3');
  const unit = `salu-update-${Math.floor(deps.now() / 1000)}`;
  const r = await deps.run([
    'systemd-run', '--no-block', '--collect', `--unit=${unit}`, `--setenv=SALU_INSTALL_URL=${installerUrl(want)}`,
    ...(want ? [`--setenv=SALU_VERSION=${want.startsWith('v') ? want : 'v' + want}`] : []),
    'bash', '-c', 'curl -fsSL --retry 3 "$SALU_INSTALL_URL" | bash',
  ]);
  if (!r.ok) return bad(`could not start the update: ${firstProblem(r.out)}`);
  return { ok: true, message: `the update to ${want ?? 'the latest release'} is running on the box (log: /var/log/salu-install.log); it restarts the control service when it is done, so ask for status in a few minutes`, data: { unit, version: want ?? 'latest' } };
};
