import { realDeps } from '../deps.ts';
import { loginSet } from './login.ts';
import { projectCreate, projectRemove } from './projects.ts';
import { status } from './status.ts';
import { update } from './update.ts';
import type { BoxDeps, Handlers, Verb } from './types.ts';

export type { BoxDeps, Handler, HandlerResult, Handlers, Verb } from './types.ts';

/**
 * Who may send each verb. Every verb is the admin's: the control channel answers only to the Mac key that was
 * paired with the box (src/control/keys.ts), and no member holds it. A member's personal key and the shared
 * sync key sign tickets, replies and actions on a project's remote and nothing here. Adding a verb means
 * deciding its row; the test fails until it has one.
 */
export const VERB_ROLE: Record<Verb, 'admin'> = {
  ping: 'admin',
  status: 'admin',
  'login.set': 'admin',
  'project.create': 'admin',
  'project.remove': 'admin',
  update: 'admin',
};

/** The box's verb handlers (docs/control-channel.md). Pass `deps` in tests; the control service uses the real ones. */
export function createHandlers(deps: BoxDeps = realDeps()): Handlers {
  return {
    ping: async () => ({ ok: true, message: `salu ${deps.version} is listening`, data: { version: deps.version } }),
    status: status(deps),
    'login.set': loginSet(deps),
    'project.create': projectCreate(deps),
    'project.remove': projectRemove(deps),
    update: update(deps),
  };
}
