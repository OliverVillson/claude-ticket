import type { Parsed } from '../args.ts';
import { flagBool, flagNum, flagStr } from '../args.ts';
import { openDb } from '../../db/db.ts';
import { getProjectById } from '../../db/queries.ts';
import { resolveProject } from '../../core/resolve.ts';
import { CliError } from '../../core/errors.ts';
import { dim, green, red } from '../../core/ansi.ts';
import { insideWorker, originUrl } from '../../core/kernel.ts';
import { unsignedWarning } from '../../sync/format.ts';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { ensureHome } from '../../core/paths.ts';
import { loadNtfy, newTopic, publishNtfy, saveNtfy } from '../../sync/ntfy.ts';
import { checkRemote } from '../../sync/git.ts';
import { getRemote, listRemotes, pendingMessages, pendingOutReplies, pendingOutTickets, removeRemote, setRemote, unreadCount } from '../../sync/store.ts';
import { boxName, syncAll, syncProject, type SyncSummary } from '../../sync/sync.ts';
import { helpIf } from './_shared.ts';

const HELP = `salu remote add <project> [git-url] [--box] [--name N] [--force]
salu remote list [--json]
salu remote remove <project>
salu remote sync [project] [--watch] [--interval seconds]
salu remote ntfy [--topic NAME | --off | --test] [--server URL]

Run a project on another computer (an always-on Linux box) with git as the only link: no server, no open
port. Tickets go to the box, results and messages come back, all through the project's own git remote
(git-url, default: the project's "origin"), on the branch salu/inbox and salu/<ticket> branches.

On your computer:  salu remote add web                 tickets you add to "web" are sent to the box
On the box:        salu remote add web <url> --box     this machine runs them and reports back
                   salu remote sync --watch            keep exchanging (every 30s, --interval to change)

Phone notifications (on the box): \`salu remote ntfy\` makes a private topic name; subscribe to it in the free ntfy
app. From then on each message the box posts also goes to ntfy as one line (the title only, never the body).

Messages from the box are kept locally (see \`salu notif\`). Sync needs you to be logged in to git on each
machine. Anyone who can push to the remote can send the box tickets, so use a private repository.`;

const ago = (t: number | null) => {
  if (!t) return 'never';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
};

function describe(s: SyncSummary): string {
  const bits: string[] = [];
  if (s.ticketsSent) bits.push(`sent ${s.ticketsSent} ticket${s.ticketsSent === 1 ? '' : 's'}`);
  if (s.ticketsReceived) bits.push(`got ${s.ticketsReceived} ticket${s.ticketsReceived === 1 ? '' : 's'}`);
  if (s.repliesSent) bits.push(`sent ${s.repliesSent} repl${s.repliesSent === 1 ? 'y' : 'ies'}`);
  if (s.repliesReceived) bits.push(`got ${s.repliesReceived} repl${s.repliesReceived === 1 ? 'y' : 'ies'}`);
  if (s.messagesSent) bits.push(`sent ${s.messagesSent} message${s.messagesSent === 1 ? '' : 's'}`);
  if (s.messagesReceived) bits.push(`${s.messagesReceived} new message${s.messagesReceived === 1 ? '' : 's'}`);
  if (s.branchesPushed.length) bits.push(`pushed ${s.branchesPushed.join(', ')}`);
  return bits.length ? bits.join(', ') : 'nothing new';
}

const warnUnsigned = () => {
  const w = unsignedWarning();
  if (w) console.error(`${red('!')} ${w}`);
};

export async function remote(p: Parsed): Promise<number> {
  if (helpIf(p, HELP)) return 0;
  if (insideWorker()) throw new CliError('salu remote is for you, not for agents.');
  const db = openDb();
  const [sub, ...rest] = p.positional;
  switch (sub) {
    case 'add': {
      const [ref, urlArg] = rest;
      if (!ref) throw new CliError('usage: salu remote add <project> [git-url] [--box]');
      const project = resolveProject(db, ref);
      const url = urlArg ?? originUrl(project.path);
      if (!url) throw new CliError(`"${project.name}" has no git remote of its own. Pass one: salu remote add "${project.name}" https://github.com/you/repo`);
      if (!flagBool(p, 'force')) {
        const problem = checkRemote(url);
        if (problem) throw new CliError(`${problem}\n(--force saves it anyway)`);
      }
      const role = flagBool(p, 'box') ? 'box' : 'client';
      setRemote(db, { project_id: project.id, url, role, name: flagStr(p, 'name') ?? (role === 'box' ? boxName() : '') });
      console.log(`${green('✓')} ${project.name} ${dim(`→ ${url}`)} ${dim(role === 'box' ? '(this machine runs its tickets)' : '(tickets you add are sent to the box)')}`);
      if (role === 'box') console.log(dim('  keep it in sync with: salu remote sync --watch'));
      warnUnsigned();
      return 0;
    }
    case 'list':
    case 'ls':
    case undefined: {
      const rows = listRemotes(db).map((r) => {
        const project = getProjectById(db, r.project_id);
        return { project: project?.name ?? `#${r.project_id}`, url: r.url, role: r.role, last_sync: r.last_sync, error: r.last_error, waiting: pendingOutTickets(db, r.project_id).length + pendingOutReplies(db, r.project_id).length + pendingMessages(db, r.project_id).length };
      });
      if (flagBool(p, 'json')) {
        console.log(JSON.stringify({ remotes: rows, unread: unreadCount(db) }, null, 2));
        return 0;
      }
      if (!rows.length) {
        console.log('no remotes yet. Try: salu remote add <project> [git-url] [--box]');
        return 0;
      }
      for (const r of rows) {
        console.log(`${r.project}  ${dim(`${r.role}  ${r.url}`)}`);
        console.log(`  ${r.error ? red('✗ ' + r.error) : dim(`synced ${ago(r.last_sync)}`)}${r.waiting ? dim(`, ${r.waiting} waiting to be sent`) : ''}`);
      }
      const unread = unreadCount(db);
      if (unread) console.log(dim(`\n${unread} unread message${unread === 1 ? '' : 's'} from the box`));
      return 0;
    }
    case 'remove':
    case 'rm': {
      if (!rest[0]) throw new CliError('usage: salu remote remove <project>');
      const project = resolveProject(db, rest[0]);
      if (!getRemote(db, project.id)) throw new CliError(`"${project.name}" has no remote`);
      removeRemote(db, project.id);
      console.log(`${green('✓')} ${project.name} ${dim('no longer syncs (the inbox branch on the remote is left alone)')}`);
      return 0;
    }
    case 'ntfy': {
      if (flagBool(p, 'off')) {
        rmSync(join(ensureHome(), 'ntfy.json'), { force: true });
        console.log(`${green('✓')} phone notifications are off ${dim('(SALU_NTFY_TOPIC in the environment still wins)')}`);
        return 0;
      }
      const given = flagStr(p, 'topic');
      let cfg = loadNtfy();
      if (given || !cfg) {
        try {
          cfg = saveNtfy(given ?? newTopic(), flagStr(p, 'server'));
        } catch (e) {
          throw new CliError(e instanceof Error ? e.message : String(e));
        }
      }
      console.log(`${green('✓')} phone notifications: ${cfg.server}/${cfg.topic}`);
      console.log(dim('  On your phone: install ntfy, tap +, subscribe to the topic above. Keep it secret: anyone with it can read the titles.'));
      if (flagBool(p, 'test')) {
        const err = publishNtfy({ title: 'It works: salu can reach your phone', level: 'success', project: 'test', type: 'note' }, cfg);
        if (err) throw new CliError(`could not publish: ${err}`);
        console.log(`${green('✓')} sent a test notification`);
      }
      return 0;
    }
    case 'sync': {
      const only = rest[0] ? [resolveProject(db, rest[0]).id] : undefined;
      if (!listRemotes(db).length) throw new CliError('no remotes yet. Try: salu remote add <project> [git-url] [--box]');
      warnUnsigned();
      const once = (): boolean => {
        let bad = false;
        for (const r of syncAll(db, only)) {
          if (r.error) {
            bad = true;
            console.error(`${red('✗')} ${r.project}: ${r.error}`);
          } else console.log(`${green('✓')} ${r.project} ${dim(describe(r.summary!))}`);
        }
        return bad;
      };
      if (!flagBool(p, 'watch')) return once() ? 1 : 0;
      const every = Math.max(5, flagNum(p, 'interval') ?? 30) * 1000;
      let stop = false;
      process.on('SIGINT', () => (stop = true));
      process.on('SIGTERM', () => (stop = true));
      let quiet = false;
      while (!stop) {
        const results = syncAll(db, only);
        const busy = results.some((r) => r.error || (r.summary && describe(r.summary) !== 'nothing new'));
        if (busy || !quiet) {
          for (const r of results) console.log(`${new Date().toISOString()} ${r.project}: ${r.error ? 'error: ' + r.error : describe(r.summary!)}`);
        }
        quiet = !busy;
        for (let waited = 0; waited < every && !stop; waited += 500) await Bun.sleep(500);
      }
      return 0;
    }
    default:
      throw new CliError(`unknown: salu remote ${sub}\n\n${HELP}`);
  }
}

