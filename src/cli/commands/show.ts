import type { Parsed } from '../args.ts';
import { flagBool, flagStr } from '../args.ts';
import { openDb } from '../../db/db.ts';
import { resolveTicket } from '../../core/resolve.ts';
import { CliError } from '../../core/errors.ts';
import { dim, safeText } from '../../core/ansi.ts';
import { formatAgo, formatCost, statusColor, statusIcon } from '../../core/format.ts';
import { ticketTags } from '../../db/types.ts';
import { helpIf } from './_shared.ts';

const HELP = `salu show "name" [--project P] [--id N] [--json]

What a ticket ended with: its status, the branch the work was committed on, and the worker's
short summary of what it did (or the question it is blocked on, or why it failed).`;

export async function show(p: Parsed): Promise<number> {
  if (helpIf(p, HELP)) return 0;
  const db = openDb();
  if (!p.positional.length && !flagStr(p, 'id')) throw new CliError('usage: salu show "name"');
  const t = resolveTicket(db, p.positional[0] ?? '', { project: flagStr(p, 'project'), id: flagStr(p, 'id') });
  if (flagBool(p, 'json')) {
    console.log(JSON.stringify({ id: t.id, name: t.name, project: t.project, status: t.status, branch: t.branch ?? null, summary: t.summary ?? null, error: t.error, cost_usd: t.cost_usd, tags: ticketTags(t) }, null, 2));
    return 0;
  }
  const name = safeText(t.name);
  const branch = safeText(t.branch);
  const error = safeText(t.error);
  const summary = safeText(t.summary);
  const color = statusColor(t.status);
  console.log(`${color(statusIcon(t.status))} #${t.id} ${name} ${dim(`in ${safeText(t.project)} · ${t.status}${t.cost_usd ? ` · ${formatCost(t.cost_usd)}` : ''} · updated ${formatAgo(t.updated_at)}`)}`);
  if (branch) console.log(`branch   ${branch} ${dim(`(git -C ${safeText(t.project_path)} log ${branch})`)}`);
  if (error) console.log(`${t.status === 'blocked' ? 'needs    ' : 'error    '}${error}`);
  if (summary) console.log(`\n${summary}`);
  else if (t.status === 'done') console.log(dim('\n(the worker left no summary)'));
  return 0;
}
