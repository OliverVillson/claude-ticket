import type { Parsed } from '../args.ts';
import { flagBool, flagStr } from '../args.ts';
import { openDb } from '../../db/db.ts';
import { resolveProject } from '../../core/resolve.ts';
import { CliError } from '../../core/errors.ts';
import { bold, dim, green, magenta, red, yellow } from '../../core/ansi.ts';
import { formatAgo } from '../../core/format.ts';
import { GLYPHS } from '../../ui/glyphs.ts';
import { countUnread, listNotifs, markAllRead, markRead, notifText, postLocal, resolveNotifId, shortId, type Notif } from '../../notif/index.ts';
import { listRemotes } from '../../sync/store.ts';
import { syncAll } from '../../sync/sync.ts';
import { helpIf, isTTY } from './_shared.ts';

const HELP = `salu notif [--all] [--project P] [--plain] [--json] [--no-fetch]
salu notif read <id>... | --all [--project P]
salu notif add "title" --project P [--level info|success|warn|error] [--body TEXT]

Messages from your project orchestrators: a ticket finished, is blocked on a question, failed, or the
orchestrator paused for the usage limit. Messages from a box arrive over the project's git remote (see
\`salu remote --help\`); this command fetches them first (--no-fetch skips that).

In a terminal \`salu notif\` opens the notification window: resting the mouse on a message (or pressing
Enter on it) marks it read and it goes away. --all also lists read ones. --plain (also what you get when
piped) prints the unread messages and leaves them unread; \`salu notif read\` marks them read from the
shell. \`add\` posts a message by hand (for a script, or to try the window).`;

function levelColor(n: Pick<Notif, 'level'>): (s: string) => string {
  switch (n.level) {
    case 'success':
      return green;
    case 'warn':
      return yellow;
    case 'error':
      return red;
    default:
      return dim;
  }
}

function glyph(n: Notif): string {
  switch (n.type) {
    case 'ticket.done':
      return GLYPHS.done;
    case 'ticket.blocked':
      return GLYPHS.blocked;
    case 'ticket.failed':
      return GLYPHS.failed;
    case 'orchestrator.paused':
      return magenta(GLYPHS.paused);
    default:
      return GLYPHS.dot;
  }
}

function renderLine(n: Notif, now: number): string {
  const c = levelColor(n);
  const where = `${n.project}${n.ticket ? ` › ${n.ticket.name}` : ''}`;
  return `${c(glyph(n))} #${shortId(n)} ${bold(n.title)} ${dim(`${where} · ${formatAgo(n.at, now)}`)}${n.read_at ? dim(' (read)') : ''}`;
}

export async function notif(p: Parsed): Promise<number> {
  if (helpIf(p, HELP)) return 0;
  const db = openDb();
  const [sub, ...rest] = p.positional;
  if (sub === 'read') return readCmd(p, rest);
  if (sub === 'add') return addCmd(p, rest);
  if (sub) throw new CliError(`unknown notif command "${sub}"\n\n${HELP}`);

  const all = flagBool(p, 'all');
  const projectId = flagStr(p, 'project') ? resolveProject(db, flagStr(p, 'project')!).id : undefined;
  const tty = !flagBool(p, 'plain') && !flagBool(p, 'json') && isTTY();
  if (tty) {
    const { openNotifs } = await import('../../tui/index.tsx'); // the window fetches for itself
    await openNotifs({ db, projectId, showRead: all });
    return 0;
  }
  if (p.flags.fetch !== false) {
    const clients = listRemotes(db).filter((r) => r.role === 'client').map((r) => r.project_id);
    if (clients.length) for (const r of syncAll(db, clients)) if (r.error) console.error(dim(`could not fetch new messages for ${r.project}: ${r.error}`));
  }
  const rows = listNotifs(db, { unread: !all, projectId });
  if (flagBool(p, 'json')) {
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }
  if (!rows.length) {
    console.log(dim(all ? 'no messages' : 'no unread messages'));
    return 0;
  }
  const now = Date.now();
  for (const n of [...rows].reverse()) {
    console.log(renderLine(n, now));
    for (const t of notifText(n, now)) for (const l of t.split('\n')) console.log(dim(`    ${l}`));
  }
  const unread = countUnread(db);
  console.log(dim(`${unread} unread · salu notif read --all marks them read`));
  return 0;
}

function readCmd(p: Parsed, ids: string[]): number {
  const db = openDb();
  if (flagBool(p, 'all')) {
    const projectId = flagStr(p, 'project') ? resolveProject(db, flagStr(p, 'project')!).id : undefined;
    const n = markAllRead(db, projectId);
    console.log(`${green(GLYPHS.done)} marked ${n} message${n === 1 ? '' : 's'} read`);
    return 0;
  }
  if (!ids.length) throw new CliError('say which message: salu notif read <id>..., or --all');
  const full = ids.map((s) => resolveNotifId(db, s));
  const bad = ids.filter((_, i) => !full[i]);
  if (bad.length) throw new CliError(`no such message: ${bad.join(', ')} (ids are the #codes in salu notif --all)`);
  const n = markRead(db, full as string[]);
  console.log(`${green(GLYPHS.done)} marked ${n} message${n === 1 ? '' : 's'} read`);
  return 0;
}

function addCmd(p: Parsed, words: string[]): number {
  const db = openDb();
  const title = words.join(' ').trim();
  const project = flagStr(p, 'project');
  if (!title || !project) throw new CliError('usage: salu notif add "title" --project P [--level info|success|warn|error] [--body TEXT]');
  const level = flagStr(p, 'level') || 'info';
  if (!['info', 'success', 'warn', 'error'].includes(level)) throw new CliError('level must be one of info, success, warn, error');
  postLocal(db, resolveProject(db, project).id, { type: 'note', level: level as Notif['level'], title, body: flagStr(p, 'body') || undefined });
  console.log(`${green(GLYPHS.done)} posted`);
  return 0;
}
