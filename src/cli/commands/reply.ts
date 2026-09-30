import type { Parsed } from '../args.ts';
import { flagBool, flagStr } from '../args.ts';
import { openDb } from '../../db/db.ts';
import { listTurns, replyToTicket } from '../../db/queries.ts';
import { resolveTicket } from '../../core/resolve.ts';
import { CliError } from '../../core/errors.ts';
import { bold, dim, green } from '../../core/ansi.ts';
import { readStatus } from '../../orchestrator/status.ts';
import { helpIf } from './_shared.ts';
import type { Turn, TicketView } from '../../db/types.ts';

const HELP = `salu reply "name" "message" [--project P] [--now]
salu reply "name"                          show the conversation on the ticket

Keep talking to a ticket after it has a reply. The message resumes the same worker session (it keeps
everything it learned) on the same salu/ branch; a done, blocked or failed ticket goes back in the
queue. If the ticket is running, the message waits and becomes the next turn. --now moves it to the
front of the queue. Use it to answer a blocked ticket's question, too.`;

/** The conversation as plain lines: the ticket's first prompt, then each follow-up and reply. */
export function conversationLines(t: TicketView, turns: Turn[]): string[] {
  const out = [`${bold('you')} ${dim('· first prompt')}`, ...t.query.trim().split('\n').map((l) => '  ' + l)];
  for (const x of turns) {
    out.push('', `${x.role === 'user' ? bold('you') : green('worker')} ${dim(`· ${new Date(x.created_at).toLocaleString()}${x.role === 'user' && !x.delivered ? ' · waiting for the worker' : ''}`)}`);
    out.push(...x.body.trim().split('\n').map((l) => '  ' + l));
  }
  return out;
}

export async function reply(p: Parsed): Promise<number> {
  if (helpIf(p, HELP)) return 0;
  const db = openDb();
  const [ref, ...rest] = p.positional;
  if (!ref && !flagStr(p, 'id')) throw new CliError('usage: salu reply "name" "message"');
  const t = resolveTicket(db, ref ?? '', { project: flagStr(p, 'project'), id: flagStr(p, 'id') });
  const message = rest.join(' ').trim();
  if (!message) {
    for (const l of conversationLines(t, listTurns(db, t.id))) console.log(l);
    return 0;
  }
  const q = replyToTicket(db, t.id, message, { now: flagBool(p, 'now') });
  const st = readStatus(db);
  const where = q.status === 'running' ? 'it is running; your message is the next turn' : q.status === 'todo' ? 'queued' : q.status;
  console.log(`${green('✓')} sent to #${q.id} ${q.name} ${dim(`(${where})`)}`);
  console.log(st.alive ? dim(`(orchestrator running, pid ${st.pid})`) : dim('(start it with `salu run`)'));
  return 0;
}
