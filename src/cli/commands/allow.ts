import type { Parsed } from '../args.ts';
import { flagStr } from '../args.ts';
import { openDb } from '../../db/db.ts';
import { allowTicket } from '../../core/allow.ts';
import { resolveTicket } from '../../core/resolve.ts';
import { CliError } from '../../core/errors.ts';
import { dim, green } from '../../core/ansi.ts';
import { readStatus } from '../../orchestrator/status.ts';
import { helpIf } from './_shared.ts';

const HELP = `salu allow "name" [--tool 'Bash(git clone *)'] [--project P] [--id N]

The fix for a ticket that is blocked on a permission. Workers run unattended, so anything that
would need approval is refused and the ticket ends blocked ("needs permission: Bash(git clone *)").
This adds what it was refused (or --tool) to the ticket's tools as an extra allowed rule, clears
the block and queues the ticket again. Only that ticket changes; allowing more rules for every
ticket in a project is \`salu change project "name" --tools 'also:Bash(git clone *)'\`.
Pushing, remotes and git config stay denied whatever you allow.`;

export async function allow(p: Parsed): Promise<number> {
  if (helpIf(p, HELP)) return 0;
  const db = openDb();
  const ref = p.positional[0];
  if (!ref && !flagStr(p, 'id')) throw new CliError('usage: salu allow "name" [--tool \'Bash(git clone *)\']');
  const t = resolveTicket(db, ref ?? '', { project: flagStr(p, 'project'), id: flagStr(p, 'id') });
  const tool = flagStr(p, 'tool');
  const { ticket, rules } = allowTicket(db, t.id, tool ? [tool] : undefined);
  const st = readStatus(db);
  console.log(`${green('✓')} #${ticket.id} ${ticket.name} may now use ${rules.join(', ')}; queued again ${dim(st.alive ? '(orchestrator running)' : '(start it with `salu run`)')}`);
  return 0;
}
