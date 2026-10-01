import type { Parsed } from '../args.ts';
import { flagBool, flagStr } from '../args.ts';
import { openDb } from '../../db/db.ts';
import { getProjectById, listTurns, markFollowUpsDelivered, replyToTicket } from '../../db/queries.ts';
import { resolveTicket } from '../../core/resolve.ts';
import { CliError } from '../../core/errors.ts';
import { bold, dim, green, stripControl } from '../../core/ansi.ts';
import { readStatus } from '../../orchestrator/status.ts';
import { publishDecisionPick, publishReply, syncProject } from '../../sync/sync.ts';
import { getRemote } from '../../sync/store.ts';
import { answerAndNotify, answerOpenWithText } from '../../threads/decide.ts';
import { listDecisions } from '../../threads/store.ts';
import { helpIf } from './_shared.ts';
import type { Turn, TicketView } from '../../db/types.ts';

const HELP = `salu reply "name" "message" [--project P] [--now]
salu reply "name" --pick N [--decision ID] [--now]   answer a decision the worker asked (N from 1)
salu reply "name"                          show the conversation on the ticket

Keep talking to a ticket after it has a reply. The message resumes the same worker session (it keeps
everything it learned) on the same salu/ branch; a done, blocked or failed ticket goes back in the
queue. If the ticket is running, the message waits and becomes the next turn. --now moves it to the
front of the queue. Use it to answer a blocked ticket's question, too.

A worker can ask a decision (a question with options and a recommended one) and carry on with the
recommendation. --pick answers the newest open one, or the one named by --decision. Picking the
recommended option only records it; any other pick tells the worker to change course.`;

/** The conversation as plain lines: the ticket's first prompt, then each follow-up and reply. */
export function conversationLines(t: TicketView, turns: Turn[]): string[] {
  const out = [`${bold('you')} ${dim('· first prompt')}`, ...stripControl(t.query).trim().split('\n').map((l) => '  ' + l)];
  for (const x of turns) {
    out.push('', `${x.role === 'user' ? bold('you') : green('worker')} ${dim(`· ${new Date(x.created_at).toLocaleString()}${x.role === 'user' && !x.delivered ? ' · waiting for the worker' : ''}`)}`);
    out.push(...stripControl(x.body).trim().split('\n').map((l) => '  ' + l));
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
  const pickRaw = flagStr(p, 'pick');
  if (pickRaw !== undefined) {
    if (message) throw new CliError('use --pick on its own, or a message; not both');
    const open = listDecisions(db, t.id, { open: true });
    const wanted = flagStr(p, 'decision');
    const d = wanted ? open.find((x) => x.id === Number(wanted)) : open[open.length - 1];
    if (!d) throw new CliError(wanted ? `no open decision #${wanted} on "${t.name}"` : `"${t.name}" has no open decision`);
    const n = Number(pickRaw);
    const r = answerAndNotify(db, t.id, d.id, n - 1, { now: flagBool(p, 'now') });
    const label = d.options[n - 1]!.label;
    const pickProject = getProjectById(db, t.project_id);
    const pickRemote = pickProject ? getRemote(db, pickProject.id) : null;
    if (pickProject && pickRemote && publishDecisionPick(db, pickProject, t, d.id, n - 1, `Decision on "${d.question}": I choose "${label}".`, { now: flagBool(p, 'now') })) {
      markFollowUpsDelivered(db, t.id);
      try {
        syncProject(db, pickProject, pickRemote);
      } catch (e: any) {
        console.error(dim('could not reach the box now: ' + String(e?.message ?? e) + ' (it will be sent on the next `salu sync`)'));
      }
    }
    console.log(`${green('✓')} decision #${d.id}: ${stripControl(label)} ${dim(r.ticket ? '(told the worker, ticket is ' + r.ticket.status + ')' : '(the worker already went with this)')}`);
    return 0;
  }
  if (!message) {
    for (const l of conversationLines(t, listTurns(db, t.id))) console.log(l);
    return 0;
  }
  const q = replyToTicket(db, t.id, message, { now: flagBool(p, 'now') });
  answerOpenWithText(db, t.id, message);
  const project = getProjectById(db, q.project_id);
  const remote = project ? getRemote(db, project.id) : null;
  if (project && remote && publishReply(db, project, q, message, { now: flagBool(p, 'now') })) {
    // This ticket runs on the box: the message goes there, and nothing waits for a local worker.
    markFollowUpsDelivered(db, q.id);
    try {
      syncProject(db, project, remote);
      console.log(`${green('✓')} sent to #${q.id} ${q.name} ${dim(`(on the box: ${remote.url})`)}`);
    } catch (e: any) {
      console.log(`${green('✓')} saved for #${q.id} ${q.name} ${dim('(it will be sent on the next `salu remote sync`)')}`);
      console.error(dim('could not reach the remote now: ' + String(e?.message ?? e)));
    }
    return 0;
  }
  const st = readStatus(db);
  const where = q.status === 'running' ? 'it is running; your message is the next turn' : q.status === 'todo' ? 'queued' : q.status;
  console.log(`${green('✓')} sent to #${q.id} ${stripControl(q.name)} ${dim(`(${where})`)}`);
  console.log(st.alive ? dim(`(orchestrator running, pid ${st.pid})`) : dim('(start it with `salu run`)'));
  return 0;
}
