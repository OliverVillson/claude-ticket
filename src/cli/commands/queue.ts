import type { Parsed } from '../args.ts';
import { flagBool, flagStr } from '../args.ts';
import { openDb } from '../../db/db.ts';
import { queueAll, queueTicket, subtreeIds, unqueueTicket } from '../../db/queries.ts';
import { resolveProjectRef, resolveTicket } from '../../core/resolve.ts';
import { CliError } from '../../core/errors.ts';
import { dim, green } from '../../core/ansi.ts';
import { readStatus } from '../../orchestrator/status.ts';
import { helpIf } from './_shared.ts';

const HELP = `salu queue "name"... [--project P] [--now]
salu queue --all [project]
salu unqueue "name"... [--project P]

A ticket added with --save is only saved (status backlog). Queue it to make it eligible to run: a running
orchestrator picks it up at once, otherwise \`salu run\` does. --now also moves it to the front.
\`salu queue\` re-queues a done, failed or blocked ticket with a fresh attempt count.
\`salu queue --all\` queues every saved ticket (in one project and its subprojects, if given).
\`salu unqueue\` takes a queued ticket that has not started back to the backlog.`;

function note(): string {
  const st = readStatus(openDb());
  return st.alive ? dim(`(orchestrator running, pid ${st.pid})`) : dim('(start it with `salu run`)');
}

export async function queue(p: Parsed): Promise<number> {
  if (helpIf(p, HELP)) return 0;
  const db = openDb();
  if (flagBool(p, 'all')) {
    const scope = p.positional[0] ?? flagStr(p, 'project');
    const ids = scope ? subtreeIds(db, resolveProjectRef(db, scope).id) : undefined;
    const n = queueAll(db, { projectIds: ids });
    console.log(n ? `${green('✓')} queued ${n} ticket${n === 1 ? '' : 's'} ${note()}` : 'nothing saved to queue');
    return 0;
  }
  if (!p.positional.length && !flagStr(p, 'id')) throw new CliError('usage: salu queue "name"...  |  salu queue --all [project]');
  const refs = p.positional.length ? p.positional : [''];
  for (const ref of refs) {
    const t = resolveTicket(db, ref, { project: flagStr(p, 'project'), id: flagStr(p, 'id') });
    const q = queueTicket(db, t.id, { now: flagBool(p, 'now') });
    console.log(`${green('✓')} queued #${q.id} ${q.name} ${dim(`in ${q.project}`)}`);
  }
  console.log(note());
  return 0;
}

export async function unqueue(p: Parsed): Promise<number> {
  if (helpIf(p, HELP)) return 0;
  const db = openDb();
  if (!p.positional.length && !flagStr(p, 'id')) throw new CliError('usage: salu unqueue "name"...');
  for (const ref of p.positional.length ? p.positional : ['']) {
    const t = resolveTicket(db, ref, { project: flagStr(p, 'project'), id: flagStr(p, 'id') });
    const q = unqueueTicket(db, t.id);
    console.log(`${green('✓')} #${q.id} ${q.name} is saved, not queued`);
  }
  return 0;
}
