import type { Database } from 'bun:sqlite';
import { CliError } from '../core/errors.ts';
import { byLabel, type Sender } from '../sync/format.ts';
import { getRemote } from '../sync/store.ts';
import { getSeat, listMembers } from './store.ts';

/**
 * Roles. The admin owns the project and the box; a member can add tickets and reply, nothing more.
 *
 * What a person can do from afar is exactly what the sync channel carries: add a ticket, reply to one,
 * resolve or reopen one. The allow list, kernel settings, the roster and the keys have no verb on that
 * channel at all (and the control channel only answers to the Mac key the admin paired, see
 * src/box/handlers/index.ts), so the checks below decide the one thing that is left: whose tickets a
 * resolve or reopen may touch.
 *
 *   no roster yet        everything is allowed, as in v1
 *   admin (own key)      everything
 *   member (own key)     add tickets, reply to any ticket, resolve or reopen their own tickets
 *   shared key           proves nobody, so it counts as a member without a name: add, reply, and
 *                        resolve or reopen only tickets nobody owns (made before the roster); never admin
 */

/** Why `sender` may not `act` on a ticket with these labels, or null when it may. */
export function whyNot(db: Database, projectId: number, sender: Sender | undefined, act: 'resolve' | 'reopen', labels: string[]): string | null {
  if (listMembers(db, projectId).length === 0) return null;
  if (sender?.role === 'admin') return null;
  const owners = labels.filter((l) => l.startsWith('by-'));
  if (sender?.name) {
    if (owners.includes(byLabel(sender.name))) return null;
    return `only the ticket's owner or an admin can ${act} it`;
  }
  if (owners.length === 0) return null;
  return `the shared key cannot ${act} someone's ticket: use your own key, or ask an admin`;
}

/**
 * On a computer that only sends to a box (the project's remote is a client), the roster, seats and keys it
 * holds are not the box's: changing them here would look like it worked and do nothing. Say so.
 */
export function requireOwnerSide(db: Database, projectId: number, what: string): void {
  if (getRemote(db, projectId)?.role === 'client') throw new CliError(`${what} lives on the box, and only its admin can change it: ask them, or run this on the box`);
}

/**
 * Which seat a ticket runs on decides whose login and quota it spends, so it is never taken from a file:
 * `seat` is a tag a remote ticket cannot carry, and the seat is chosen on the box (the scheduler, or the
 * admin). This is the rule for anything that pins a seat for a sender: an admin may pin any seat, a member
 * only their own, the shared key none. Lending (a seat's owner letting teammates use spare time) is the
 * scheduler's decision, not a pin. No roster: v1, no restriction.
 */
export function whyNotSeat(db: Database, projectId: number, sender: Sender | undefined, seatLabel: string): string | null {
  if (listMembers(db, projectId).length === 0) return null;
  if (sender?.role === 'admin') return null;
  const seat = getSeat(db, projectId, seatLabel);
  if (!seat) return `no seat called "${seatLabel}"`;
  if (sender?.name && seat.owner?.toLowerCase() === sender.name.toLowerCase()) return null;
  return sender?.name ? `seat "${seat.label}" is not yours: only its owner or an admin can pin it` : 'the shared key cannot pin a seat: use your own key, or ask an admin';
}
