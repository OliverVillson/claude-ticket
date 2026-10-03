import type { Database } from 'bun:sqlite';
import type { SeatView } from '../team/store.ts';
import { seatAuth } from '../core/seats.ts';
import { listSeats } from '../team/store.ts';
import { formatWindowMeter, getUsageSnapshot, parseUsage, sdkFetcher, usageBar } from './snapshot.ts';
import type { UsageFetch, UsageFetcher, UsageSnapshot, UsageWindow } from './snapshot.ts';

/**
 * Plan usage per seat: each seat has its own 5-hour and weekly windows, read with that seat's own login.
 *
 * A seat holds no secret (see team/store.ts). The login lives where the box keeps seat tokens (core/seats.ts), and reaches this module only through a {@link SeatLoginResolver}: given a seat, it returns the
 * environment a Claude Code session needs to act as that seat, or null when this machine has no login for it.
 * By default that is the token saved by `salu kernel login --seat <id>`; a seat with none shows as "no login" (a ticket never borrows another seat's login, and neither does this).
 *
 * Snapshots are kept apart per seat in the `state` table (scope `seat:<id>`), so the machine's own usage
 * meter (v1) is untouched.
 */

export interface SeatLogin {
  /** Environment for the usage read, e.g. `{ CLAUDE_CODE_OAUTH_TOKEN }`. Never logged or stored here. */
  env: Record<string, string>;
}
export type SeatLoginResolver = (seat: SeatView) => SeatLogin | null | Promise<SeatLogin | null>;

/** The default: the token `salu kernel login --seat <id>` saved on this machine (core/seats.ts), if any. */
export const seatTokenLogin: SeatLoginResolver = (seat) => {
  const env = seatAuth(String(seat.id));
  return Object.keys(env).length ? { env } : null;
};

let resolver: SeatLoginResolver = seatTokenLogin;

/** Wire the place seat logins live. Returns the previous resolver (tests restore it). */
export function setSeatLoginResolver(r: SeatLoginResolver): SeatLoginResolver {
  const prev = resolver;
  resolver = r;
  return prev;
}

export const seatScope = (seatId: number) => `seat:${seatId}`;

/**
 * ok: read fine. full: a window is used up. dead: the seat's login is refused (expired or revoked), so no
 * ticket can run on it. no-login: this machine has no login for the seat. off: switched off by the admin.
 * no-reading: the login works but cannot read plan usage and no ticket has reported a limit on it yet (never shown as 0%).
 * unavailable: the plan reports no usage (API key) or the read failed for another reason.
 */
export type SeatUsageState = 'ok' | 'full' | 'dead' | 'no-login' | 'no-reading' | 'off' | 'unavailable';

export interface SeatUsage {
  seat: SeatView;
  state: SeatUsageState;
  /** One plain sentence when the state is not ok. */
  detail: string | null;
  snapshot: UsageSnapshot;
}

const EMPTY: UsageSnapshot = { available: false, reason: null, reasonKind: null, plan: null, windows: [], updatedAt: 0, fetchedAt: 0, stale: false, error: null };

/** SALU_FAKE_SEAT_USAGE: JSON `{ "<label>": <raw /usage object> | "dead" | "no-login" }` for demos and tests. */
function fakeFor(label: string): { fetch: UsageFetch } | 'no-login' | null {
  const raw = process.env.SALU_FAKE_SEAT_USAGE;
  if (!raw) return null;
  try {
    const m = JSON.parse(raw) as Record<string, unknown>;
    const v = m[label];
    if (v === undefined) return null;
    if (v === 'no-login') return 'no-login';
    const now = Date.now();
    if (v === 'dead') return { fetch: { ok: false, at: now, plan: null, windows: [], reasonKind: 'not-logged-in', reason: 'Not logged in to Claude Code (or the login expired).' } };
    return { fetch: parseUsage(v, now) };
  } catch {
    return null;
  }
}

/** One seat's usage. Never throws. */
export async function seatUsage(db: Database, seat: SeatView, o: { refresh?: boolean; force?: boolean; fetcher?: UsageFetcher; now?: number } = {}): Promise<SeatUsage> {
  const done = (state: SeatUsageState, detail: string | null, snapshot: UsageSnapshot = EMPTY): SeatUsage => ({ seat, state, detail, snapshot });
  if (seat.disabled) return done('off', 'switched off');
  const fake = o.fetcher ? null : fakeFor(seat.label);
  let fetcher = o.fetcher;
  if (!fetcher && o.refresh !== false) {
    if (fake === 'no-login') return done('no-login', 'no login for this seat on this machine');
    if (fake) fetcher = async () => fake.fetch;
    else {
      let login: SeatLogin | null = null;
      try {
        login = await resolver(seat);
      } catch {
        login = null;
      }
      if (!login) return done('no-login', 'no login for this seat on this machine');
      fetcher = sdkFetcher({ env: login.env });
    }
  }
  const snapshot = await getUsageSnapshot({ db, scope: seatScope(seat.id), fetcher, force: o.force, refresh: o.refresh, now: o.now });
  const dead = snapshot.reasonKind === 'not-logged-in' && !snapshot.windows.length;
  if (dead) return done('dead', 'the login is refused (expired or revoked): sign this seat in again', snapshot);
  if (!snapshot.available && snapshot.reasonKind === 'no-subscription') return done('no-reading', 'no reading yet: plan usage cannot be read with this login; it fills in from tickets that run on it', snapshot);
  if (!snapshot.available) return done('unavailable', snapshot.reason ?? 'usage could not be read', snapshot);
  const full = snapshot.windows.filter((w) => w.status === 'rejected' && w.id !== 'credits');
  if (full.length) return done('full', `${full.map((w) => w.short).join(' and ')} used up`, snapshot);
  return done('ok', null, snapshot);
}

/** Every seat of a project, read side by side (a slow or dead seat never holds the others up). */
export async function teamUsage(db: Database, projectId: number, o: { refresh?: boolean; force?: boolean; fetcher?: (seat: SeatView) => UsageFetcher | undefined; now?: number } = {}): Promise<SeatUsage[]> {
  return Promise.all(listSeats(db, projectId).map((s) => seatUsage(db, s, { ...o, fetcher: o.fetcher?.(s) })));
}

const pick = (s: UsageSnapshot, id: string): UsageWindow | undefined => s.windows.find((w) => w.id === id);

/** "alice  5h ▰▰▰▱▱ 62% · resets 3:45pm · week ▰▱▱▱▱ 31%", or the reason a seat has no meter. */
export function formatSeatMeter(u: SeatUsage, now = Date.now(), cells = 5): string {
  if (u.state === 'off' || u.state === 'no-login' || u.state === 'no-reading' || u.state === 'dead' || u.state === 'unavailable') return u.state === 'dead' ? `DEAD: ${u.detail}` : u.state === 'unavailable' ? `n/a: ${u.detail}` : u.detail ?? u.state;
  const parts = ['session', 'weekly'].map((id) => pick(u.snapshot, id)).filter((w): w is UsageWindow => !!w);
  const shown = parts.length ? parts : u.snapshot.windows.slice(0, 1);
  const meter = (w: UsageWindow, first: boolean) =>
    w.percentUsed == null && w.status === 'allowed'
      ? `${w.short} ok, no % reported`
      : first
        ? formatWindowMeter(w, now, cells)
        : `${w.short} ${usageBar(w.percentUsed, cells)} ${w.percentUsed ?? '?'}%`;
  const fromRuns = shown.every((w) => w.source === 'event');
  const when = fromRuns ? ` · from runs, as of ${new Date(Math.max(...shown.map((w) => w.observedAt))).toTimeString().slice(0, 5)}` : '';
  return shown.map((w, i) => meter(w, i === 0)).join(' · ') + when + (u.snapshot.stale ? ' (stale)' : '');
}

/** Plain text for `salu usage` on a project with seats: one line per seat, a dead seat named in its line. */
export function formatSeatUsageLines(us: SeatUsage[], now = Date.now()): string[] {
  const pad = Math.max(...us.map((u) => (u.seat.owner ? `${u.seat.label} (${u.seat.owner})` : u.seat.label).length));
  return us.map((u) => {
    const who = u.seat.owner ? `${u.seat.label} (${u.seat.owner})` : u.seat.label;
    return `${who.padEnd(pad)}  ${formatSeatMeter(u, now)}${u.state === 'full' ? ` · ${u.detail}` : ''}`;
  });
}
