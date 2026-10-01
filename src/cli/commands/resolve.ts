import type { Parsed } from '../args.ts';
import { flagBool, flagStr } from '../args.ts';
import { openDb } from '../../db/db.ts';
import { queueTicket, replyToTicket, resolveTicketById } from '../../db/queries.ts';
import { resolveTicket } from '../../core/resolve.ts';
import { CliError } from '../../core/errors.ts';
import { dim, green } from '../../core/ansi.ts';
import { GLYPHS } from '../../ui/glyphs.ts';
import { helpIf } from './_shared.ts';

const RESOLVE_HELP = `salu resolve "name"... [--project P]

You are finished with a ticket: mark it resolved. A ticket that finished on its own is already resolved;
this is for ones you want out of the way (blocked, failed, queued, saved). Nothing is deleted: the
conversation, branch and summary stay, and \`salu reopen\` or \`salu reply\` brings the ticket back.`;

const REOPEN_HELP = `salu reopen "name" ["message"] [--project P] [--now]

Bring a resolved ticket back. With a message it is a reply: the worker resumes the same session with it.
Without one the ticket is queued again and picks up where it left off.`;

export async function resolve(p: Parsed): Promise<number> {
  if (helpIf(p, RESOLVE_HELP)) return 0;
  const db = openDb();
  if (!p.positional.length && !flagStr(p, 'id')) throw new CliError('usage: salu resolve "name"...');
  for (const ref of p.positional.length ? p.positional : ['']) {
    const t = resolveTicket(db, ref, { project: flagStr(p, 'project'), id: flagStr(p, 'id') });
    const r = resolveTicketById(db, t.id);
    console.log(`${green(GLYPHS.done)} #${r.id} ${r.name} resolved ${dim('(`salu reopen` or `salu reply` brings it back)')}`);
  }
  return 0;
}

export async function reopen(p: Parsed): Promise<number> {
  if (helpIf(p, REOPEN_HELP)) return 0;
  const db = openDb();
  const [ref, ...rest] = p.positional;
  if (!ref && !flagStr(p, 'id')) throw new CliError('usage: salu reopen "name" ["message"]');
  const t = resolveTicket(db, ref ?? '', { project: flagStr(p, 'project'), id: flagStr(p, 'id') });
  const message = rest.join(' ').trim();
  const q = message ? replyToTicket(db, t.id, message, { now: flagBool(p, 'now') }) : queueTicket(db, t.id, { now: flagBool(p, 'now') });
  console.log(`${green('✓')} reopened #${q.id} ${q.name} ${dim(`(${q.status === 'todo' ? 'queued' : q.status})`)}`);
  return 0;
}
