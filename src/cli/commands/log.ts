import type { Parsed } from '../args.ts';
import { flagBool, flagStr } from '../args.ts';
import { openDb } from '../../db/db.ts';
import { latestRun, listRuns } from '../../db/queries.ts';
import { resolveTicket } from '../../core/resolve.ts';
import { CliError } from '../../core/errors.ts';
import { helpIf } from './_shared.ts';

const HELP = `ticket log "name" [--follow] [--raw] [--run N] [--project P] [--id N]

Shows the worker transcript of a ticket's latest run (or run N of it). --follow tails a
running one. --raw prints the stream-json lines as they were logged.`;

export async function log(p: Parsed): Promise<number> {
  if (helpIf(p, HELP)) return 0;
  const db = openDb();
  const ref = p.positional[0];
  if (!ref && !flagStr(p, 'id')) throw new CliError('usage: ticket log "name" [--follow]');
  const t = resolveTicket(db, ref ?? '', { project: flagStr(p, 'project'), id: flagStr(p, 'id') });
  const runNo = flagStr(p, 'run');
  const run = runNo ? listRuns(db, t.id).reverse()[Number(runNo) - 1] : latestRun(db, t.id);
  if (!run?.log_path) throw new CliError(`no runs yet for "${t.name}"`);
  const { renderLog } = await import('../../orchestrator/log.ts');
  await renderLog(run.log_path, { follow: flagBool(p, 'follow') && t.status === 'running', raw: flagBool(p, 'raw'), ticket: t, run });
  return 0;
}
