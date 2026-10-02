import { restartIdleProjects } from './projects.ts';
import { bad, firstProblem } from './common.ts';
import type { BoxDeps, Handler } from './types.ts';

const VERSION_RE = /^v?\d+\.\d+\.\d+(\.\d+)?$/;

/**
 * `update`: install the release (the latest unless `version`), rebuild the kernel image only when its recipe
 * changed, and restart idle runner projects so they run the new binary. The control service itself is restarted by
 * the box's own unit (Restart=always after an exit; see the installer), never from inside this handler.
 */
export const update = (deps: BoxDeps): Handler => async ({ args }) => {
  const want = args?.version === undefined ? undefined : String(args.version);
  if (want !== undefined && !VERSION_RE.test(want)) return bad('the version looks like v1.2.3');
  const up = await deps.run([deps.salu, 'update', ...(want ? [want] : [])]);
  if (!up.ok) return bad(`the update did not install: ${firstProblem(up.out)}`);
  const upToDate = /already|up to date|latest/i.test(up.out) && !want;
  // The new binary decides whether the image recipe changed. Podman is rootless, so it runs as the runner user.
  const img = await deps.run([deps.salu, 'kernel', 'setup', '--unattended', '--if-changed'], { as: deps.user, timeoutMs: 60 * 60_000 });
  if (!img.ok) return bad(`salu updated, but the kernel image did not rebuild: ${firstProblem(img.out)}. Projects keep using the old image; send update again`);
  const rebuilt = !/already current/.test(img.out);
  const r = await restartIdleProjects(deps);
  const parts = [upToDate ? 'salu is already the latest' : 'salu is updated', rebuilt ? 'the kernel image was rebuilt' : 'the kernel image did not change'];
  if (r.busy.length) parts.push(`${r.busy.join(', ')} still run the old version until they next restart`);
  return { ok: true, message: parts.join('; '), data: { rebuilt, restarted: r.restarted, busy: r.busy } };
};
