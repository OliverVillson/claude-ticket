import type { Parsed } from '../args.ts';
import { flagBool } from '../args.ts';
import { openDb } from '../../db/db.ts';
import { countTickets, getTicketById, listProjects } from '../../db/queries.ts';
import { readStatus } from '../../orchestrator/status.ts';
import { bold, cyan, dim, green, magenta, red, yellow } from '../../core/ansi.ts';
import { formatClock, formatDuration, statusColor } from '../../core/format.ts';
import { helpIf, isEmbedded } from './_shared.ts';
import { formatUsageHeader, getPause, formatPause, peekUsageSnapshot, getUsageSnapshot, sdkFetcher } from '../../usage/index.ts';
import { GLYPHS } from '../../ui/glyphs.ts';

const HELP = `salu status [--json]

One screen: whether the orchestrator is running, tickets by status, plan usage left (see
salu usage), and if it is paused, why and when it resumes.`;

export async function status(p: Parsed): Promise<number> {
  if (helpIf(p, HELP)) return 0;
  const db = openDb();
  const now = Date.now();
  const st = readStatus(db, now);
  const counts = countTickets(db);
  // A read of the plan usage takes seconds and is cached for a minute. On the terminal wait for it;
  // inside the TUI show the cache and refresh in the background so the command answers at once.
  const fetcher = sdkFetcher({ timeoutMs: 8_000 });
  let usage = peekUsageSnapshot(db);
  if (isEmbedded()) void getUsageSnapshot({ db, fetcher }).catch(() => {});
  else usage = await getUsageSnapshot({ db, fetcher }).catch(() => usage);
  if (flagBool(p, 'json')) {
    console.log(JSON.stringify({ orchestrator: st, tickets: counts, projects: listProjects(db).length, usage }, null, 2));
    return 0;
  }
  const lines: string[] = [];
  if (st.alive) {
    lines.push(`${green(GLYPHS.on)} orchestrator ${bold('running')} ${dim(`pid ${st.pid}, up ${formatDuration(now - (st.startedAt ?? now))}, ${st.workers.length} worker${st.workers.length === 1 ? '' : 's'} active`)}`);
  } else {
    lines.push(`${dim(GLYPHS.off)} orchestrator ${bold('not running')} ${dim('(salu run [--detach])')}`);
  }
  const pause = getPause(db);
  if (pause) lines.push(`${magenta('‖')} ${bold('paused')}: ${formatPause(pause, now)}`);
  lines.push(`${dim('usage')} ${usage.available ? formatUsageHeader(usage, now, 10) : dim(`n/a: ${usage.reason ?? 'unknown'}`)}`);
  lines.push('');
  const order = ['running', 'paused', 'todo', 'backlog', 'blocked', 'failed', 'done'] as const;
  lines.push(
    order
      .map((s) => `${statusColor(s)(`${counts[s]} ${s}`)}`)
      .join(dim('  ·  ')),
  );
  if (st.workers.length) {
    lines.push('');
    for (const w of st.workers) {
      const t = getTicketById(db, w.ticketId);
      const name = t ? t.name : `#${w.ticketId}`;
      const detail = [w.model, `${w.turns} turn${w.turns === 1 ? '' : 's'}`, w.lastTool && `last: ${w.lastTool}`].filter(Boolean).join(', ');
      lines.push(`  ${cyan(GLYPHS.running)} ${name} ${dim(`${formatDuration(now - w.startedAt)} · ${detail}`)}`);
    }
  }
  const blocked = counts.blocked;
  if (blocked) lines.push('', yellow(`${blocked} ticket${blocked === 1 ? '' : 's'} blocked on a question: salu list --status blocked`));
  if (counts.failed) lines.push(red(`${counts.failed} failed: salu log "name" shows why; salu change "name" --status todo retries`));
  console.log(lines.join('\n'));
  return 0;
}
