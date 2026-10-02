/**
 * The handlers `salu control watch` runs. `ping` is built in. The rest are filled in by the box handlers
 * (src/box/handlers): they replace the entries of `handlers` below, nothing else in src/control changes.
 */
import { VERSION } from '../cli/dispatch.ts';
import type { Handlers } from './watcher.ts';

const notYet = (verb: string) => async () => ({ ok: false, message: `This box's salu does not know "${verb}" yet. Run salu update on the box.` });

export const handlers: Handlers = {
  ping: async () => ({ ok: true, message: `salu ${VERSION} is listening.`, data: { version: VERSION } }),
  status: notYet('status'),
  'login.set': notYet('login.set'),
  'project.create': notYet('project.create'),
  'project.remove': notYet('project.remove'),
  update: notYet('update'),
};

/** The body of the heartbeat the box rewrites every minute. The box handlers may add disk and ticket counts. */
export function heartbeatData(): Record<string, unknown> {
  return { version: VERSION };
}
