import { realDeps } from '../deps.ts';
import { loginSet } from './login.ts';
import { projectCreate, projectRemove } from './projects.ts';
import { status } from './status.ts';
import { update } from './update.ts';
import type { BoxDeps, Handlers } from './types.ts';

export type { BoxDeps, Handler, HandlerResult, Handlers, Verb } from './types.ts';

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
