import type { Parsed } from '../args.ts';
import { flagBool, flagStr } from '../args.ts';
import { openDb } from '../../db/db.ts';
import { resolveTicket } from '../../core/resolve.ts';
import { CliError } from '../../core/errors.ts';
import { helpIf } from './_shared.ts';

const HELP = `ticket plan "name" [--yes] [--project P] [--id N]

Asks Claude to split one ticket into smaller sub-tickets, shows them, and adds them on
approval. The original ticket is kept and marked done once the sub-tickets are added.`;

export async function plan(p: Parsed): Promise<number> {
  if (helpIf(p, HELP)) return 0;
  const db = openDb();
  const ref = p.positional[0];
  if (!ref && !flagStr(p, 'id')) throw new CliError('usage: ticket plan "name"');
  const t = resolveTicket(db, ref ?? '', { project: flagStr(p, 'project'), id: flagStr(p, 'id') });
  const { planTicket } = await import('../../orchestrator/plan.ts');
  return planTicket(t, { yes: flagBool(p, 'yes') });
}
