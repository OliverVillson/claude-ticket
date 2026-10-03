import type { Database } from 'bun:sqlite';
import { CliError } from '../core/errors.ts';
import { personName } from '../sync/format.ts';

/**
 * The team of a project: who is on it, who owns it, and which Claude seats it can run tickets on.
 * Data only. Per-person keys, permissions, the scheduler and the seat logins read this later; nothing
 * here changes how a ticket is dispatched, so a database without members behaves exactly as in v1.
 * A seat names a login ("alice's Team seat"); it never holds the login itself.
 */

export type Role = 'admin' | 'member';
export const ROLES: Role[] = ['admin', 'member'];

export type SeatPlan = 'pro' | 'max' | 'team' | 'enterprise' | 'api' | 'other';
export const SEAT_PLANS: SeatPlan[] = ['pro', 'max', 'team', 'enterprise', 'api', 'other'];

export interface Member {
  id: number;
  project_id: number;
  name: string;
  role: Role;
  added_at: number;
}

export interface Seat {
  id: number;
  project_id: number;
  label: string;
  owner_id: number | null; // the member the seat belongs to; null once that member leaves (the seat is then disabled)
  plan: SeatPlan;
  /** The owner lets teammates' tickets use this seat's spare time. Off until the owner turns it on. */
  lend: number; // 0 | 1
  /** Most of the seat's 5-hour window, in percent, others may use while lending. */
  lend_cap_pct: number | null;
  /** Hours of the day (0-23, box local time) the lending is open: from (inclusive) to (exclusive), wrapping past midnight. Both null = any hour. */
  lend_from: number | null;
  lend_to: number | null;
  disabled: number; // 0 | 1
  created_at: number;
}

export interface SeatView extends Seat {
  owner: string | null;
}

/** Idempotent, and not tied to the schema version (same reason as the sync tables). */
export function ensureTeamTables(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      added_at INTEGER NOT NULL,
      UNIQUE (project_id, name)
    );
    CREATE TABLE IF NOT EXISTS seats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      owner_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
      plan TEXT NOT NULL DEFAULT 'team',
      lend INTEGER NOT NULL DEFAULT 0,
      lend_cap_pct INTEGER,
      disabled INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      UNIQUE (project_id, label)
    );
  `);
  const seatCols = db.query<{ name: string }, []>('PRAGMA table_info(seats)').all().map((c) => c.name);
  if (!seatCols.includes('lend_from')) db.exec('ALTER TABLE seats ADD COLUMN lend_from INTEGER;');
  if (!seatCols.includes('lend_to')) db.exec('ALTER TABLE seats ADD COLUMN lend_to INTEGER;');
  // One row per ticket that started on a seat that is not its requester's: who lent, who borrowed, what it was expected to cost.
  db.exec(`
    CREATE TABLE IF NOT EXISTS lend_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      ticket_id INTEGER NOT NULL,
      ticket_name TEXT NOT NULL,
      seat_id INTEGER NOT NULL,
      lender TEXT,
      borrower TEXT NOT NULL,
      est_pct REAL NOT NULL DEFAULT 0,
      est_usd REAL NOT NULL DEFAULT 0,
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS lend_log_seat ON lend_log(seat_id, at);
    CREATE UNIQUE INDEX IF NOT EXISTS lend_log_ticket ON lend_log(ticket_id, seat_id);
  `);
  // Which seat ran a ticket (null = the machine's own login, as in v1).
  if (!db.query<{ name: string }, []>('PRAGMA table_info(tickets)').all().some((c) => c.name === 'seat_id')) db.exec('ALTER TABLE tickets ADD COLUMN seat_id INTEGER REFERENCES seats(id) ON DELETE SET NULL;');
}

function cleanName(raw: string, what: string): string {
  const n = personName(raw);
  if (!n) throw new CliError(`give ${what} a name`);
  return n;
}

export function listMembers(db: Database, projectId: number): Member[] {
  return db.query<Member, [number]>('SELECT * FROM members WHERE project_id = ? ORDER BY (role = \'admin\') DESC, id').all(projectId);
}

export function getMember(db: Database, projectId: number, name: string): Member | null {
  return db.query<Member, [number, string]>('SELECT * FROM members WHERE project_id = ? AND name = ? COLLATE NOCASE').get(projectId, name) ?? null;
}

const admins = (db: Database, projectId: number) => db.query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM members WHERE project_id = ? AND role = 'admin'").get(projectId)!.n;

/** Add a person. The first one to join a project owns it, so a project is never left without an admin. */
export function addMember(db: Database, projectId: number, name: string, role?: Role): Member {
  const n = cleanName(name, 'the member');
  if (role && !ROLES.includes(role)) throw new CliError(`role is admin or member, not "${role}"`);
  if (getMember(db, projectId, n)) throw new CliError(`${n} is already on this project`);
  const first = listMembers(db, projectId).length === 0;
  db.query('INSERT INTO members (project_id, name, role, added_at) VALUES (?, ?, ?, ?)').run(projectId, n, first ? 'admin' : (role ?? 'member'), Date.now());
  return getMember(db, projectId, n)!;
}

export function setRole(db: Database, projectId: number, name: string, role: Role): Member {
  if (!ROLES.includes(role)) throw new CliError(`role is admin or member, not "${role}"`);
  const m = getMember(db, projectId, name);
  if (!m) throw new CliError(`${name} is not on this project`);
  if (m.role === 'admin' && role !== 'admin' && admins(db, projectId) <= 1) throw new CliError('a project needs an admin: make someone else admin first');
  db.query('UPDATE members SET role = ? WHERE id = ?').run(role, m.id);
  return { ...m, role };
}

/** Remove a person. Their seats stay on the project but are switched off, since the login is theirs. */
export function removeMember(db: Database, projectId: number, name: string): Member {
  const m = getMember(db, projectId, name);
  if (!m) throw new CliError(`${name} is not on this project`);
  if (m.role === 'admin' && admins(db, projectId) <= 1) throw new CliError('that is the only admin: make someone else admin first');
  db.query('UPDATE seats SET disabled = 1, lend = 0 WHERE owner_id = ?').run(m.id);
  db.query('DELETE FROM members WHERE id = ?').run(m.id);
  return m;
}

const SEAT_SELECT = 'SELECT s.*, m.name AS owner FROM seats s LEFT JOIN members m ON m.id = s.owner_id';

export function listSeats(db: Database, projectId: number): SeatView[] {
  return db.query<SeatView, [number]>(`${SEAT_SELECT} WHERE s.project_id = ? ORDER BY s.id`).all(projectId);
}

export function getSeat(db: Database, projectId: number, label: string): SeatView | null {
  return db.query<SeatView, [number, string]>(`${SEAT_SELECT} WHERE s.project_id = ? AND s.label = ? COLLATE NOCASE`).get(projectId, label) ?? null;
}

/** Register a seat for a member (one Team or Enterprise seat per person is the intended use). */
export function addSeat(db: Database, projectId: number, label: string, o: { owner?: string; plan?: SeatPlan } = {}): SeatView {
  const l = cleanName(label, 'the seat');
  if (o.plan && !SEAT_PLANS.includes(o.plan)) throw new CliError(`plan is one of ${SEAT_PLANS.join(', ')}`);
  if (getSeat(db, projectId, l)) throw new CliError(`a seat called "${l}" already exists`);
  let ownerId: number | null = null;
  if (o.owner) {
    const m = getMember(db, projectId, o.owner);
    if (!m) throw new CliError(`${o.owner} is not on this project: salu team add ${o.owner}`);
    ownerId = m.id;
  }
  db.query('INSERT INTO seats (project_id, label, owner_id, plan, created_at) VALUES (?, ?, ?, ?, ?)').run(projectId, l, ownerId, o.plan ?? 'team', Date.now());
  return getSeat(db, projectId, l)!;
}

export function removeSeat(db: Database, projectId: number, label: string): SeatView {
  const s = getSeat(db, projectId, label);
  if (!s) throw new CliError(`no seat called "${label}"`);
  db.query('DELETE FROM seats WHERE id = ?').run(s.id);
  return s;
}

/** Turn lending on or off. Lending is the owner's choice and is off by default; the window and cap rules live in team/lend.ts. */
export function setLend(db: Database, projectId: number, label: string, on: boolean, o: { cap?: number | null; from?: number | null; to?: number | null } = {}): SeatView {
  const s = getSeat(db, projectId, label);
  if (!s) throw new CliError(`no seat called "${label}"`);
  if (on && s.disabled) throw new CliError(`seat "${s.label}" is switched off`);
  if (o.cap != null && (!Number.isInteger(o.cap) || o.cap < 1 || o.cap > 100)) throw new CliError('the cap is a whole number of percent, 1 to 100');
  const hour = (h: number | null | undefined) => h == null || (Number.isInteger(h) && h >= 0 && h <= 23);
  if (!hour(o.from) || !hour(o.to) || (o.from == null) !== (o.to == null)) throw new CliError('the window is two hours, 0 to 23: --from 22 --to 7');
  if (on && o.from != null && o.from === o.to) throw new CliError('the window needs two different hours (leave both out for any hour)');
  const keep = o.from === undefined && o.to === undefined;
  db.query('UPDATE seats SET lend = ?, lend_cap_pct = ?, lend_from = ?, lend_to = ? WHERE id = ?').run(
    on ? 1 : 0,
    on ? (o.cap ?? s.lend_cap_pct ?? 50) : null,
    on ? (keep ? s.lend_from : (o.from ?? null)) : null,
    on ? (keep ? s.lend_to : (o.to ?? null)) : null,
    s.id,
  );
  return getSeat(db, projectId, label)!;
}

export function setSeatDisabled(db: Database, projectId: number, label: string, disabled: boolean): SeatView {
  const s = getSeat(db, projectId, label);
  if (!s) throw new CliError(`no seat called "${label}"`);
  db.query('UPDATE seats SET disabled = ?, lend = CASE WHEN ? = 1 THEN 0 ELSE lend END WHERE id = ?').run(disabled ? 1 : 0, disabled ? 1 : 0, s.id);
  return getSeat(db, projectId, label)!;
}

/** Record which seat a ticket ran on. */
export function setTicketSeat(db: Database, ticketId: number, seatId: number | null): void {
  db.query('UPDATE tickets SET seat_id = ? WHERE id = ?').run(seatId, ticketId);
}

/** Seats a ticket of `member` may use now: their own, plus teammates' that are lending. Switched-off seats never. */
export function usableSeats(db: Database, projectId: number, member: string | null): SeatView[] {
  return listSeats(db, projectId).filter((s) => !s.disabled && (s.lend === 1 || (member != null && s.owner?.toLowerCase() === member.toLowerCase())));
}
