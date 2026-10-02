import { saveBoxLogin, validToken } from '../login.ts';
import { restartIdleProjects } from './projects.ts';
import { bad } from './common.ts';
import type { BoxDeps, Handler } from './types.ts';

/** `login.set`: the one box login, for every runner project and the kernel proxy (src/box/login.ts). */
export const loginSet = (deps: BoxDeps): Handler => async ({ args, secret }) => {
  if (args?.kind !== 'subscription') return bad('login.set only knows kind "subscription" (the token from `claude setup-token`)');
  let token: string;
  try {
    token = secret('token').toString('utf8').trim();
  } catch {
    return bad('the command carried no token: run `claude setup-token` on your Mac and send it again');
  }
  if (!validToken(token)) return bad('that does not look like a Claude token: use the whole line `claude setup-token` prints');
  try {
    saveBoxLogin(token);
  } catch (e: any) {
    return bad(`could not save the login on the box: ${e.message}`);
  }
  // The kernel proxy re-reads the file on every request; orchestrators read the environment once, so restart the idle ones.
  const r = await restartIdleProjects(deps);
  const busy = r.busy.length ? ` ${r.busy.length} busy project${r.busy.length === 1 ? '' : 's'} (${r.busy.join(', ')}) will use it after their running tickets finish and the project restarts` : '';
  return { ok: true, message: `the box login is saved${r.restarted.length ? ` and ${r.restarted.length} idle project${r.restarted.length === 1 ? '' : 's'} restarted` : ''}.${busy}`.trim(), data: { restarted: r.restarted, busy: r.busy } };
};
