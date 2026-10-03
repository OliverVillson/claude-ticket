import type { Parsed } from '../args.ts';
import { flagBool } from '../args.ts';
import { openDb } from '../../db/db.ts';
import { dim, green, red, yellow } from '../../core/ansi.ts';
import { formatSeatUsageLines, formatUsageLines, getUsageSnapshot, teamUsage } from '../../usage/index.ts';
import { resolveProject } from '../../core/resolve.ts';
import { flagStr } from '../args.ts';
import { listSeats } from '../../team/store.ts';
import type { UsageSnapshot } from '../../usage/index.ts';
import { forecast } from '../../sched/forecast.ts';
import { helpIf } from './_shared.ts';

const HELP = `salu usage [--project P] [--json] [--refresh]

How much of your Claude plan's usage is left: the 5-hour session window, the weekly window,
and per-model weekly windows (Opus, Sonnet) when your plan has them, with reset times.
Read without a model turn, cached for a minute. --refresh reads it again right now.
On a project with seats (salu seat), one meter per seat instead, each read with that seat's own login;
a seat whose login is refused is named DEAD. Seats are read side by side, so one dead seat hides nothing.
Not available with an API key or a third-party provider (only subscription plans report usage).`;

/** Colour a plain usage line by how full its window is. */
export function colorUsageLine(line: string, snap: UsageSnapshot): string {
  const w = snap.windows.find((x) => line.startsWith(x.label));
  if (!w) return dim(line);
  const c = w.status === 'rejected' || (w.percentUsed ?? 0) >= 95 ? red : w.status === 'warning' || (w.percentUsed ?? 0) >= 80 ? yellow : green;
  return c(line);
}

export async function usage(p: Parsed): Promise<number> {
  if (helpIf(p, HELP)) return 0;
  const db = openDb();
  const proj = (() => {
    try {
      return resolveProject(db, flagStr(p, 'project'));
    } catch {
      return null; // not inside a project: the machine's own meter, as before
    }
  })();
  if (proj && listSeats(db, proj.id).length) {
    const us = await teamUsage(db, proj.id, { force: flagBool(p, 'refresh') });
    if (flagBool(p, 'json')) {
      console.log(JSON.stringify(us.map((u) => ({ seat: u.seat.label, owner: u.seat.owner, state: u.state, detail: u.detail, usage: u.snapshot })), null, 2));
      return 0;
    }
    console.log(dim(`${proj.name} seats`));
    const lines = formatSeatUsageLines(us);
    console.log(lines.map((l, i) => (us[i]!.state === 'dead' ? red(l) : us[i]!.state === 'full' ? yellow(l) : us[i]!.state === 'ok' ? green(l) : dim(l))).join('\n'));
    return 0;
  }
  const snap = await getUsageSnapshot({ db, force: flagBool(p, 'refresh') });
  if (flagBool(p, 'json')) {
    console.log(JSON.stringify(snap, null, 2));
    return 0;
  }
  const lines = formatUsageLines(snap);
  if (!snap.available) {
    console.log(dim(lines[0]));
    return 0;
  }
  console.log(lines.map((l, i) => (i === 0 && snap.plan ? dim(l) : colorUsageLine(l, snap))).join('\n'));
  const f = forecast(db, snap);
  if (f.queued.length) {
    const waits = f.queued.filter((q) => !q.fits).length;
    console.log(dim(`queue: ${f.queued.length} ticket${f.queued.length === 1 ? '' : 's'}, about $${f.totalUsd.toFixed(2)}${f.totalPct != null ? ` (~${Math.round(f.totalPct)}% of a window)` : ''}${waits ? `, ${waits} would wait for a reset` : ''} · salu sched`));
  }
  return 0;
}
