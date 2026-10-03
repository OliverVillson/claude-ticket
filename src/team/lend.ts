import type { Database } from 'bun:sqlite';
import { CliError } from '../core/errors.ts';
import { ticketLabels, type TicketView } from '../db/types.ts';
import { byLabel, whoAmI } from '../sync/format.ts';
import { getSeat, listMembers, type Member, type SeatView } from './store.ts';

/**
 * Borrowing spare seat time. A teammate may lend a capped slice of their seat to the project; a ticket whose
 * requester has no room on their own seat may then start on it. Everything here is off until the lender
 * switches it on for their own seat.
 *
 * TERMS NOT CHECKED. Whether a Claude plan's terms allow one person's seat to serve a teammate's ticket was never
 * checked at the source. Lending is the lender's call and the lender's responsibility.
 *
 * Who the requester is: the `by-<name>` label a signed ticket carries (set from the signature, so a member cannot
 * claim another's, see sync.ts and team/perms.ts). A ticket without one (made on the box, before the roster, or
 * sent with the shared key, which proves nobody) has no requester. It owns no seat, so it is treated like any
 * borrower: seats nobody owns are free to it, a member's seat only when that member is lending it.
 */

export const NO_ONE = '(no named requester)';

export const TERMS_WARNING =
  "Whether your Claude plan's terms allow your seat to serve a teammate's ticket has NOT been checked at the source.\nLending is your choice and your responsibility: read the plan's terms yourself before you switch it on.";

/** The 5-hour window the cap is counted over. */
export const LEND_WINDOW_MS = 5 * 3_600_000;

/** The member a ticket belongs to, or null when it has no (known) requester. */
export function requesterOf(db: Database, t: Pick<TicketView, 'project_id' | 'labels'>): Member | null {
  const labels = ticketLabels(t).filter((l) => l.startsWith('by-'));
  if (!labels.length) return null;
  return listMembers(db, t.project_id).find((m) => labels.includes(byLabel(m.name))) ?? null;
}

/** Whether the lending window is open at `now` (box local hour). Both bounds null = always. */
export function windowOpen(seat: Pick<SeatView, 'lend_from' | 'lend_to'>, now: number): boolean {
  const { lend_from: from, lend_to: to } = seat;
  if (from == null || to == null) return true;
  const h = new Date(now).getHours();
  return from < to ? h >= from && h < to : h >= from || h < to;
}

/** Percent of the lender's 5-hour window already promised to borrowed tickets. */
export function borrowedPct(db: Database, seatId: number, now: number): number {
  return db.query<{ n: number | null }, [number, number]>('SELECT SUM(est_pct) AS n FROM lend_log WHERE seat_id = ? AND at > ?').get(seatId, now - LEND_WINDOW_MS)?.n ?? 0;
}

export type Use = { kind: 'own' } | { kind: 'borrow' } | { kind: 'no'; why: string };

/**
 * May this ticket start on this seat, and as what? `estPct` is what the ticket is expected to use of the window.
 * A seat nobody owns, or the requester's own: `own`. Someone else's seat (also for a ticket with no requester,
 * such as one sent with the shared key): only when they are lending, the window is open and the cap has room for this ticket.
 */
export function useOf(db: Database, t: TicketView, seat: SeatView, now: number, estPct: number | null): Use {
  const who = requesterOf(db, t);
  if (seat.owner_id == null || seat.owner_id === who?.id) return { kind: 'own' };
  if (!seat.lend) return { kind: 'no', why: `${seat.owner ?? 'its owner'} is not lending it` };
  if (!windowOpen(seat, now)) return { kind: 'no', why: `${seat.owner}'s lending is closed now (open ${seat.lend_from}:00-${seat.lend_to}:00)` };
  const cap = seat.lend_cap_pct ?? 50;
  const used = borrowedPct(db, seat.id, now);
  // A ticket with no estimate yet is counted as a quarter of the cap, so it cannot slip past it.
  const need = estPct ?? cap / 4;
  if (used + need > cap) return { kind: 'no', why: `${seat.owner}'s lending cap is used (${Math.round(used)}% of ${cap}% in the last 5 hours)` };
  return { kind: 'borrow' };
}

/** Log a ticket that started on a borrowed seat: who lent, who borrowed, what it should cost. Cost is read from the ticket later. */
export function logBorrow(db: Database, t: TicketView, seat: SeatView, est: { pct: number | null; usd: number }, now = Date.now()): boolean {
  const who = requesterOf(db, t);
  if (seat.owner_id == null || seat.owner_id === who?.id) return false;
  db.query('INSERT INTO lend_log (project_id, ticket_id, ticket_name, seat_id, lender, borrower, est_pct, est_usd, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(t.project_id, t.id, t.name, seat.id, seat.owner, who?.name ?? NO_ONE, est.pct ?? 0, est.usd, now);
  return true;
}

export interface LendRow {
  at: number;
  ticket_id: number;
  ticket: string;
  seat: string;
  lender: string | null;
  borrower: string;
  est_pct: number;
  est_usd: number;
  /** What the ticket has cost so far (all its runs), from the ticket itself. */
  cost_usd: number;
}

export function lendLog(db: Database, projectId: number, limit = 50): LendRow[] {
  return db
    .query<LendRow, [number, number]>(
      `SELECT l.at, l.ticket_id, l.ticket_name AS ticket, s.label AS seat, l.lender, l.borrower, l.est_pct, l.est_usd, COALESCE(t.cost_usd, 0) AS cost_usd
       FROM lend_log l LEFT JOIN seats s ON s.id = l.seat_id LEFT JOIN tickets t ON t.id = l.ticket_id
       WHERE l.project_id = ? ORDER BY l.id DESC LIMIT ?`,
    )
    .all(projectId, limit);
}

/** Only the seat's owner switches lending ON for it (the admin may switch it off). `me` is who is at the keyboard. */
export function requireLender(db: Database, projectId: number, label: string, on: boolean, me = whoAmI()): SeatView {
  const s = getSeat(db, projectId, label);
  if (!s) throw new CliError(`no seat called "${label}"`);
  if (!on) return s;
  if (!s.owner) throw new CliError(`seat "${s.label}" has no owner, so nobody can lend it`);
  if (s.owner.toLowerCase() !== me.toLowerCase()) throw new CliError(`only ${s.owner} can switch lending on for "${s.label}" (you are ${me}; set SALU_USER if that is wrong). Lending is the lender's choice and responsibility.`);
  return s;
}
