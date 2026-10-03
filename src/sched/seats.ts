import type { Database } from 'bun:sqlite';
import type { TicketView } from '../db/types.ts';
import type { SeatView } from '../team/store.ts';
import { listMembers, listSeats } from '../team/store.ts';
import { byLabel } from '../sync/format.ts';
import { ticketLabels } from '../db/types.ts';
import { buildSnapshot, STALE_AFTER_MS, type UsageSnapshot } from '../usage/snapshot.ts';
import { formatSeatMeter, seatHasLogin, seatScope, type SeatUsage } from '../usage/seats.ts';
import { fits, MAX_SKIPS, plan, SELF_SEAT, type Decision, type Planned } from './policy.ts';
import { readStats, SCHED_STATE } from './stats.ts';
import { getState } from '../db/queries.ts';

/**
 * Seat-aware placement: a ticket starts on the seat that has room. For a project with seats, each queued
 * ticket is tried against every seat it may use (its own seat when it has one, because a session resumes
 * where it started; otherwise any enabled seat of the project), with that seat's own windows and its own
 * percent-per-dollar. Never another member's lent seat: borrowing is a separate, off-by-default step.
 * A project without seats goes through the machine's own meter exactly as before.
 */

/** A seat as the scheduler sees it this tick. */
export interface SeatView2 {
  seat: SeatView;
  usage: SeatUsage;
  /** Percent of the 5-hour window already promised to tickets started a moment ago, before the meter shows it. */
  promised: number;
}

/** How long a just-started ticket counts against its seat before the meter is trusted to show it. */
export const PROMISE_MS = 2 * 60_000;

export type SeatMap = Map<number, SeatView2[]>;

/** Read every project's seats from what is cached (no network). `promises` are tickets started a moment ago. */
export function peekSeats(db: Database, now: number, promises: { seatId: number; pct: number; at: number }[] = []): SeatMap {
  const out: SeatMap = new Map();
  const projects = db.query<{ id: number }, []>('SELECT id FROM projects').all();
  for (const { id } of projects) {
    const seats = listSeats(db, id);
    if (!seats.length) continue;
    out.set(
      id,
      seats.map((seat) => {
        const snapshot = buildSnapshot(db, now, null, STALE_AFTER_MS, seatScope(seat.id));
        const promised = promises.filter((x) => x.seatId === seat.id && now - x.at < PROMISE_MS).reduce((a, x) => a + x.pct, 0);
        return { seat, usage: seatState(seat, snapshot), promised };
      }),
    );
  }
  return out;
}

/** Same states as the usage view, from the cached snapshot and whether a login is here. */
export function seatState(seat: SeatView, snapshot: UsageSnapshot): SeatUsage {
  const done = (state: SeatUsage['state'], detail: string | null): SeatUsage => ({ seat, state, detail, snapshot });
  if (seat.disabled) return done('off', 'switched off');
  if (!seatHasLogin(seat)) return done('no-login', 'no login for this seat on this machine');
  if (snapshot.reasonKind === 'not-logged-in' && !snapshot.windows.length) return done('dead', 'the login is refused (expired or revoked): sign this seat in again');
  if (!snapshot.available) return done('unavailable', snapshot.reason ?? 'usage could not be read');
  const full = snapshot.windows.filter((w) => w.status === 'rejected' && w.id !== 'credits');
  if (full.length) return done('full', `${full.map((w) => w.short).join(' and ')} used up`);
  return done('ok', null);
}

/** The snapshot a ticket is judged against on a seat: the seat's windows plus what was promised since the last read. */
function judged(v: SeatView2): UsageSnapshot {
  if (!v.promised) return v.usage.snapshot;
  return { ...v.usage.snapshot, windows: v.usage.snapshot.windows.map((w) => (w.id === 'session' && w.percentUsed != null ? { ...w, percentUsed: Math.min(100, w.percentUsed + v.promised) } : w)) };
}

/**
 * Whose seats a ticket may use. Borrowing is off (W6), so a seat is usable only when it is the project's (no owner),
 * the ticket author's own, or, for a ticket with no author (added on this machine), an admin's. The author is the
 * member named by the ticket's `by-<name>` label; a `by-` label that names nobody on the team gets the project's
 * ownerless seats only. A seat already on the ticket is checked the same way: a pinned seat is never a way round it.
 * Returns why a seat is closed to the ticket, or null when it is open.
 */
export function seatClosedTo(db: Database, t: TicketView, seat: SeatView): string | null {
  if (seat.owner_id == null) return null;
  const labels = ticketLabels(t).map((l) => l.toLowerCase());
  const members = listMembers(db, t.project_id);
  const named = labels.some((l) => l.startsWith('by-'));
  const authors = members.filter((m) => labels.includes(byLabel(m.name)));
  const mine = authors.length ? authors.every((m) => m.id === seat.owner_id) : !named && members.some((m) => m.id === seat.owner_id && m.role === 'admin');
  const lentNote = `${seat.owner ?? 'its owner'} has not lent it`;
  return mine ? null : authors.length ? `it is ${seat.owner}'s seat and ${lentNote}` : `it is ${seat.owner}'s seat, not the ticket author's (${lentNote})`;
}

export interface Placement {
  /** The seat that takes the ticket, or null when none does. */
  seat: SeatView2 | null;
  planned: Planned | null;
  /** Every seat that was looked at and did not take it, with the reason. */
  others: { seat: string; why: string; until: number | null }[];
}

/** Which seat takes this ticket now? The one with the most room among those it fits on. */
export function place(db: Database, t: TicketView, seats: SeatView2[], now: number, stats = readStats(db)): Placement {
  const others: Placement['others'] = [];
  const pinned = t.seat_id != null;
  let best: { v: SeatView2; room: number; p: Planned } | null = null;
  const pool = pinned ? seats.filter((v) => v.seat.id === t.seat_id) : seats;
  if (pinned && !pool.length) return { seat: null, planned: null, others: [{ seat: `#${t.seat_id}`, why: 'its seat is no longer on this project', until: null }] };
  for (const v of pool) {
    const label = v.seat.label;
    const u = v.usage;
    const closed = seatClosedTo(db, t, v.seat);
    if (closed) {
      others.push({ seat: label, why: closed, until: null });
      continue;
    }
    if (u.state === 'off' || u.state === 'no-login' || u.state === 'dead') {
      others.push({ seat: label, why: u.state === 'dead' ? 'its login is refused (DEAD)' : u.state === 'off' ? 'it is switched off' : 'it has no login here', until: null });
      continue;
    }
    if (u.state === 'full') {
      const until = u.snapshot.windows.filter((w) => w.status === 'rejected' && w.id !== 'credits').map((w) => w.resetsAt).filter((x): x is number => x != null);
      others.push({ seat: label, why: u.detail ?? 'a window is used up', until: until.length ? Math.min(...until) : null });
      continue;
    }
    const p = plan(db, t, stats, v.seat.id);
    const f = fits(db, p, judged(v), now);
    if (!f.ok) {
      others.push({ seat: label, why: f.why, until: f.until });
      continue;
    }
    const session = u.snapshot.windows.find((w) => w.id === 'session')?.percentUsed;
    const room = 100 - ((session ?? 50) + v.promised);
    if (!best || room > best.room) best = { v, room, p };
  }
  if (!best) return { seat: null, planned: null, others };
  // Seats that would also have fit are not "why not"; only the ones that did not are explained.
  return { seat: best.v, planned: best.p, others };
}

const joined = (others: Placement['others']) => others.map((o) => `${o.seat}: ${o.why}`).join('; ');

function readSkips(db: Database): Record<string, number> {
  try {
    const v = JSON.parse(getState(db, SCHED_STATE.skips) ?? '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/**
 * The seat-aware `decide`. Same walk as the single-meter one (dispatch order, at most {@link MAX_SKIPS}
 * pass-overs, hold until the earliest reset), but a ticket in a project with seats is placed on a seat.
 * `legacy` decides for tickets of projects with no seats.
 */
export function decideSeats(
  db: Database,
  candidates: TicketView[],
  seats: SeatMap,
  legacy: (c: TicketView) => { ok: true } | { ok: false; why: string; until: number | null },
  now = Date.now(),
): Decision {
  const stats = readStats(db);
  const skips = readSkips(db);
  const skipped: Decision['skipped'] = [];
  let earliest: number | null = null;
  for (const c of candidates) {
    const mine = seats.get(c.project_id);
    if (!mine) {
      const f = legacy(c);
      if (f.ok) return { seat: SELF_SEAT, pick: c, hold: null, skipped };
      skipped.push({ id: c.id, name: c.name, why: f.why });
      if (f.until != null && (earliest == null || f.until < earliest)) earliest = f.until;
    } else {
      const pl = place(db, c, mine, now, stats);
      if (pl.seat) return { seat: pl.seat.seat.label, seatId: pl.seat.seat.id, pick: c, hold: null, skipped, placed: { name: c.name, seat: pl.seat.seat.label, others: pl.others.map(({ seat, why }) => ({ seat, why })) } };
      skipped.push({ id: c.id, name: c.name, why: `fits no seat (${joined(pl.others)})` });
      for (const o of pl.others) if (o.until != null && (earliest == null || o.until < earliest)) earliest = o.until;
    }
    if ((skips[String(c.id)] ?? 0) >= MAX_SKIPS) break;
  }
  const first = skipped[0];
  if (!first) return { seat: SELF_SEAT, pick: null, hold: null, skipped };
  return { seat: SELF_SEAT, pick: null, hold: { until: earliest, reason: `${first.name} ${first.why}` }, skipped };
}

/** One line per seat for `salu sched`: the meter, or why the seat cannot take tickets. */
export function seatLines(seats: SeatMap, now = Date.now()): string[] {
  const out: string[] = [];
  for (const list of seats.values())
    for (const v of list) out.push(`  ${v.seat.owner ? `${v.seat.label} (${v.seat.owner})` : v.seat.label}  ${formatSeatMeter(v.usage, now)}${v.usage.state === 'full' ? ` · ${v.usage.detail}` : ''}`);
  return out;
}
