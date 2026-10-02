import { readFileSync } from 'node:fs';
import { updateStatusFile } from './handlers/update.ts';
import { snapshot } from './handlers/status.ts';
import type { BoxDeps } from './handlers/types.ts';

/**
 * What goes into the heartbeat the watcher rewrites every minute (`runWatcher`'s `heartbeat` option, which signs it).
 * The watcher wants the answer at once, so this returns the last snapshot and refreshes it in the background:
 * the first beat has the version only, the next ones also disk, tickets and each project's state. `update` is how the
 * last update ended ("update refused: the installer's signature did not verify..."), written by the update unit.
 */
export function heartbeatSource(deps: BoxDeps): () => Record<string, unknown> {
  let last: Record<string, unknown> = { version: deps.version };
  let busy = false;
  const updateLine = (): string | undefined => {
    try {
      return readFileSync(updateStatusFile(), 'utf8').trim().slice(0, 200) || undefined;
    } catch {
      return undefined;
    }
  };
  return () => {
    if (!busy) {
      busy = true;
      snapshot(deps)
        .then((s) => {
          last = { version: s.version, disk: s.disk, tickets: s.tickets, projects: s.projects.map((p) => ({ project: p.project, service: p.service, running: p.running, todo: p.todo })) };
        })
        .catch(() => {})
        .finally(() => (busy = false));
    }
    const u = updateLine();
    return u ? { ...last, update: u } : last;
  };
}
