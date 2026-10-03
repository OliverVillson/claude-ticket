import type { Database } from 'bun:sqlite';
import type { Ticket } from '../db/types.ts';
import { ticketLabels } from '../db/types.ts';
import { getState } from '../db/queries.ts';
import { GLYPHS } from '../ui/glyphs.ts';
import { listMembers, listSeats, type Member, type SeatView } from './store.ts';

/**
 * What the CLI, the TUI and the phone show about a team: who added a ticket, which seat runs it and how
 * much of that seat's window is left. One place, so the three agree. Read-only; nothing here changes how
 * a ticket is dispatched. A database without members shows nothing extra, exactly as in v1.
 */

export interface SeatMeter {
  /** share of the seat's 5-hour window used, 0..100; null when nothing is known yet */
  percentUsed: number | null;
  resetsAt: number | null;
}

/** Where per-seat usage is kept until the usage package owns it: state key `seat_usage:<seat id>`, JSON `{percentUsed, resetsAt}`. */
export const seatUsageKey = (seatId: number) => `seat_usage:${seatId}`;

export function seatMeter(db: Database, seatId: number): SeatMeter {
  try {
    const v = JSON.parse(getState(db, seatUsageKey(seatId)) ?? 'null');
    const used = typeof v?.percentUsed === 'number' ? Math.max(0, Math.min(100, Math.round(v.percentUsed))) : null;
    return { percentUsed: used, resetsAt: typeof v?.resetsAt === 'number' ? v.resetsAt : null };
  } catch {
    return { percentUsed: null, resetsAt: null };
  }
}

/** `▰▰▰▱▱ 62% left`, or `n/a` while the seat has not reported yet. */
export function meterText(m: SeatMeter, cells = 5): string {
  if (m.percentUsed == null) return 'n/a';
  const left = 100 - m.percentUsed;
  const full = left <= 0 ? 0 : Math.max(1, Math.round((left / 100) * cells));
  return `${GLYPHS.barFull.repeat(full)}${GLYPHS.barEmpty.repeat(cells - full)} ${left}% left`;
}

export interface TeamSeat extends SeatView {
  meter: SeatMeter;
}

export interface TeamView {
  members: Member[];
  seats: TeamSeat[];
  /** true when the project has any members or seats; false means "a v1 project": show no team columns */
  active: boolean;
}

export function loadTeam(db: Database, projectId: number): TeamView {
  const members = listMembers(db, projectId);
  const seats = listSeats(db, projectId).map((s) => ({ ...s, meter: seatMeter(db, s.id) }));
  return { members, seats, active: members.length > 0 || seats.length > 0 };
}

/** The person a ticket belongs to: its `by-<name>` label (set by sync), shown under the member's own spelling when there is one. */
export function ticketAuthor(t: Pick<Ticket, 'labels'>, members: Member[] = []): string | null {
  const l = ticketLabels(t).find((x) => typeof x === 'string' && x.startsWith('by-'));
  if (!l) return null;
  const slug = l.slice(3);
  const known = members.find((m) => m.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') === slug);
  return known?.name ?? slug;
}

/** The `by` cell of a list row: the author, and `@owner` when the ticket runs on someone else's seat. */
export function byCell(t: Pick<Ticket, 'labels' | 'seat_id'>, team: TeamView | undefined): string | null {
  if (!team) return null;
  const w = ticketWho(t, team);
  return w.author ? w.author + (w.seatOwner ? ` @${w.seatOwner}` : '') : w.seatOwner ? `@${w.seatOwner}` : null;
}

export interface TicketWho {
  author: string | null;
  seat: string | null;
  /** the seat's owner, when it differs from the author (a borrowed seat) */
  seatOwner: string | null;
  meter: SeatMeter | null;
}

export function ticketWho(t: Pick<Ticket, 'labels' | 'seat_id'>, team: TeamView): TicketWho {
  const author = ticketAuthor(t, team.members);
  const s = t.seat_id != null ? team.seats.find((x) => x.id === t.seat_id) : undefined;
  const borrowed = !!s?.owner && !!author && s.owner.toLowerCase() !== author.toLowerCase();
  return { author, seat: s?.label ?? null, seatOwner: borrowed ? s!.owner : null, meter: s?.meter ?? null };
}

/** A line a friend can paste to join: install, who they are, and the project's remote. The key is only included when asked for. */
export function inviteBlock(o: { project: string; name: string; url: string | null; key: string | null; installUrl?: string }): string {
  const url = o.url ?? '<the project git url>';
  const key = o.key ?? '<ask the admin for the signing key>';
  return [
    `# Join ${o.project} on salu (as ${o.name})`,
    `curl -fsSL ${o.installUrl ?? 'https://olivervillson.github.io/salu/i'} | bash`,
    `export SALU_USER=${JSON.stringify(o.name)}`,
    `salu add project ${JSON.stringify(o.project)} .   # run inside your checkout of the repo`,
    `salu remote add ${JSON.stringify(o.project)} ${url} --key ${key}`,
    `salu remote sync --watch`,
  ].join('\n');
}
