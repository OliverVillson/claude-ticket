import type { Database } from 'bun:sqlite';
import { listTickets } from '../db/queries.ts';
import { formatResetTime } from '../usage/format.ts';
import type { UsageSnapshot } from '../usage/snapshot.ts';
import { fits, plan, readLast, type Planned } from './policy.ts';
import { peekSeats, place, seatLines, type SeatMap } from './seats.ts';
import { percentPerUsd, readStats, schedMode, type SchedMode } from './stats.ts';

export interface Forecast {
  mode: SchedMode;
  /** Plan-percent per dollar learned from finished runs, or null. */
  percentPerUsd: number | null;
  queued: { name: string; model: string; effort: string; usd: number; pct: number | null; learned: boolean; fits: boolean; why?: string; seat?: string }[];
  /** One line per seat: its meter, or why it cannot take tickets. Empty for a machine without seats. */
  seats: string[];
  totalUsd: number;
  totalPct: number | null;
}

export function forecast(db: Database, snap: UsageSnapshot, now = Date.now(), seats: SeatMap = peekSeats(db, now)): Forecast {
  const stats = readStats(db);
  const rows = listTickets(db, { status: ['todo', 'paused'] }).map((t): Planned => plan(db, t, stats));
  const queued = rows.map((p) => {
    const mine = seats.get(p.ticket.project_id);
    if (mine) {
      const pl = place(db, p.ticket, mine, now, stats);
      return { name: p.ticket.name, model: p.model, effort: p.effort, usd: p.est.usd, pct: pl.planned?.est.pct ?? p.est.pct, learned: p.est.learned, fits: !!pl.seat, seat: pl.seat?.seat.label, why: pl.seat ? undefined : `no seat has room (${pl.others.map((o) => `${o.seat}: ${o.why}`).join('; ')})` };
    }
    const f = fits(db, p, snap, now);
    return { name: p.ticket.name, model: p.model, effort: p.effort, usd: p.est.usd, pct: p.est.pct, learned: p.est.learned, fits: f.ok, why: f.ok ? undefined : f.why };
  });
  const pcts = queued.map((q) => q.pct);
  return {
    mode: schedMode(db),
    seats: seatLines(seats, now),
    percentPerUsd: percentPerUsd(db, stats),
    queued,
    totalUsd: queued.reduce((a, q) => a + q.usd, 0),
    totalPct: pcts.every((p) => p != null) && pcts.length ? (pcts as number[]).reduce((a, b) => a + b, 0) : null,
  };
}

const MODE_TEXT: Record<SchedMode, string> = {
  off: 'off: tickets run in queue order, whatever they cost',
  advise: 'advise: shows what it would do and changes nothing',
  on: 'on: starts what fits the window, skips ahead, holds when nothing fits, routes light tickets to Sonnet',
};

/** Plain-text lines for `salu sched`. */
export function formatForecast(f: Forecast, snap: UsageSnapshot, now = Date.now()): string[] {
  const out: string[] = [`scheduler ${MODE_TEXT[f.mode]}`];
  out.push(f.percentPerUsd != null ? `learned: about ${f.percentPerUsd.toFixed(1)}% of the 5-hour window per $1 of work` : 'learned: not yet (needs a few finished runs on a subscription; estimates are in dollars until then)');
  if (f.seats.length) out.push('seats:', ...f.seats);
  if (!f.queued.length) {
    out.push('queue: empty');
    return out;
  }
  const session = snap.available ? snap.windows.find((w) => w.id === 'session') : undefined;
  const left = session?.percentUsed != null ? ` · 5h window ${session.percentUsed}% used${session.resetsAt ? `, resets ${formatResetTime(session.resetsAt, now)}` : ''}` : '';
  out.push(`queue: ${f.queued.length} ticket${f.queued.length === 1 ? '' : 's'}, about $${f.totalUsd.toFixed(2)}${f.totalPct != null ? ` (~${Math.round(f.totalPct)}% of a window)` : ''}${left}`);
  for (const q of f.queued.slice(0, 12)) {
    const est = `~$${q.usd.toFixed(2)}${q.pct != null ? ` ~${Math.round(q.pct)}%` : ''}${q.learned ? '' : ' (guess)'}`;
    out.push(`  ${q.name}  ${q.model.replace(/^claude-/, '')}/${q.effort}  ${est}  ${q.fits ? (q.seat ? `fits on ${q.seat}` : 'fits') : `waits: ${q.why}`}`);
  }
  if (f.queued.length > 12) out.push(`  ... and ${f.queued.length - 12} more`);
  return out;
}

export function lastDecisionLines(db: Database, now = Date.now()): string[] {
  const l = readLast(db);
  if (!l) return [];
  const out: string[] = [];
  if (l.hold) out.push(`last decision: ${l.mode === 'on' ? 'holding' : 'would hold'} the queue${l.hold.until ? ` until ${formatResetTime(l.hold.until, now)}` : ''}: ${l.hold.reason}`);
  else if (l.wouldPick) out.push(`last decision: ${l.mode === 'on' ? 'started' : 'would start'} ${l.wouldPick}${l.placed && l.placed.name === l.wouldPick ? ` on seat ${l.placed.seat}` : ''}`);
  if (l.placed && l.placed.name === l.wouldPick) for (const o of l.placed.others) out.push(`  not on ${o.seat}: ${o.why}`);
  for (const s of l.skipped.slice(0, 5)) out.push(`  passed over ${s.name}: ${s.why}`);
  for (const r of l.routed.slice(0, 5)) out.push(`  ${r.applied ? 'routed' : 'would route'} ${r.name} to ${r.model} (${r.why})`);
  return out;
}
