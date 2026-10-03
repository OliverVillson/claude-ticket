import type { Database } from 'bun:sqlite';
import type { TicketView } from '../db/types.ts';
import { formatResetTime } from '../usage/format.ts';
import { buildSnapshot, getUsageSnapshot, peekUsageSnapshot, STALE_AFTER_MS, type UsageSnapshot } from '../usage/snapshot.ts';
import { fits, noteStarted, plan, readLast, routeQueued, saveLast, type Decision, type SchedLast } from './policy.ts';
import { decideSeats, peekSeats, type SeatMap } from './seats.ts';
import { listSeats, setTicketSeat } from '../team/store.ts';
import { seatScope, seatUsage } from '../usage/seats.ts';
import { recordRunStats, schedMode, type SchedMode } from './stats.ts';

/** What one worker run teaches the estimator. Held on the orchestrator's entry for the run. */
export interface RunWatch {
  model: string;
  effort: string;
  startPct: number | null;
  /** The registry seat the run is paid by (null = the machine's own login). */
  seatId: number | null;
  resetsAt: number | null;
  /** False once another worker overlapped this one: the meter's movement can no longer be pinned on one ticket. */
  solo: boolean;
}

/**
 * The orchestrator's view of the token-aware scheduler. Once per tick: `begin` (route queued
 * tickets, refresh the meter), `choose` for each slot, `end` (record the decision, say when the
 * queue is held). `off` does nothing, `advise` records what it would do and changes nothing,
 * `on` routes, skips ahead and holds.
 */
export class TokenAware {
  mode: SchedMode = 'advise';
  private snap!: UsageSnapshot;
  private now = 0;
  private decision: Decision | null = null;
  private routed: SchedLast['routed'] = [];
  private wouldPick: string | null = null;
  private lastSaved = '';
  private lastHold = '';
  private seats: SeatMap = new Map();
  /** Tickets started a moment ago, so the next pick in the same minute sees their share of a seat before the meter does. */
  private promises: { seatId: number; pct: number; at: number }[] = [];

  constructor(
    private readonly db: Database,
    private readonly log: (level: 'info' | 'warn' | 'error', msg: string) => void,
  ) {}

  begin(now: number): void {
    this.now = now;
    this.mode = schedMode(this.db);
    this.decision = null;
    this.wouldPick = null;
    this.routed = [];
    if (this.mode === 'off') return;
    this.snap = peekUsageSnapshot(this.db, now);
    this.promises = this.promises.filter((x) => now - x.at < 120_000);
    this.seats = peekSeats(this.db, now, this.promises);
    for (const list of this.seats.values()) for (const v of list) void seatUsage(this.db, v.seat).catch(() => {}); // each seat's own login, throttled to one read a minute
    void getUsageSnapshot({ db: this.db }).catch(() => {}); // throttled to one read a minute; the next tick sees it
    try {
      this.routed = routeQueued(this.db, this.snap, this.mode);
    } catch (e: any) {
      this.log('warn', `model routing skipped: ${String(e?.message ?? e)}`);
    }
  }

  /** `choose` hook for `claimNextTicket`. Never throws: a policy bug must not stop dispatch. */
  choose = (cands: TicketView[]): TicketView | null => {
    if (this.mode === 'off') return cands[0] ?? null;
    try {
      const d = decideSeats(this.db, cands, this.seats, (c) => fits(this.db, plan(this.db, c), this.snap, this.now), this.now);
      this.decision = d;
      this.wouldPick = d.pick?.name ?? null;
      return this.mode === 'on' ? d.pick : (cands[0] ?? null);
    } catch (e: any) {
      this.log('warn', `scheduler policy skipped: ${String(e?.message ?? e)}`);
      return cands[0] ?? null;
    }
  };

  started(t: TicketView): void {
    const d = this.decision;
    if (this.mode !== 'on' || !d) return;
    noteStarted(this.db, d, t.id);
    if (d.seatId != null && d.pick?.id === t.id) {
      setTicketSeat(this.db, t.id, d.seatId); // the seat that has room pays for it; a resumed session stays on it
      t.seat_id = d.seatId;
      const pct = plan(this.db, t, undefined, d.seatId).est.pct;
      if (pct != null) {
        this.promises.push({ seatId: d.seatId, pct, at: this.now });
        for (const list of this.seats.values()) for (const v of list) if (v.seat.id === d.seatId) v.promised += pct; // the next slot in this same tick sees it
      }
    }
  }

  /** Save the decision for `salu sched`; returns when a held queue may start (epoch ms) or null. */
  end(): number | null {
    if (this.mode === 'off') return null;
    const hold = this.mode === 'on' ? (this.decision?.hold ?? null) : null;
    const last: SchedLast = {
      at: this.now,
      seat: this.decision?.seat,
      placed: this.decision?.placed ?? null,
      mode: this.mode,
      wouldPick: this.wouldPick,
      hold: this.decision?.hold ?? null,
      skipped: (this.decision?.skipped ?? []).map(({ name, why }) => ({ name, why })),
      routed: this.routed,
    };
    // A tick that looked at nothing (empty queue) must not wipe the last real decision `salu sched` explains.
    const idle = !last.wouldPick && !last.hold && !last.skipped.length && !last.routed.length;
    const key = JSON.stringify({ ...last, at: 0 });
    const prev = idle ? readLast(this.db) : null;
    const keepPrev = !!prev && !!(prev.wouldPick || prev.hold) && prev.mode === this.mode;
    if (!keepPrev && key !== this.lastSaved) {
      this.lastSaved = key;
      saveLast(this.db, last);
    }
    const holdKey = hold ? `${hold.reason}|${hold.until}` : '';
    if (holdKey !== this.lastHold) {
      const wasHeld = this.lastHold !== '';
      this.lastHold = holdKey;
      if (hold) this.log('info', `holding the queue${hold.until ? ` until ${formatResetTime(hold.until, this.now)}` : ''}: ${hold.reason}`);
      else if (wasHeld) this.log('info', 'the queue is no longer held');
    }
    return hold?.until ?? null;
  }

  /** Called as a worker starts. */
  watch(t: TicketView, others: RunWatch[]): RunWatch {
    const seatId = t.seat_id ?? null;
    const p = plan(this.db, t, undefined, seatId ?? undefined);
    const snap = seatId != null ? peekSeatSnapshot(this.db, seatId) : (this.snap ?? peekUsageSnapshot(this.db));
    const session = this.mode === 'off' ? undefined : snap.windows.find((x) => x.id === 'session');
    const w: RunWatch = { model: p.model, effort: p.effort, seatId, startPct: session?.percentUsed ?? null, resetsAt: session?.resetsAt ?? null, solo: false };
    const sameMeter = others.filter((o) => o.seatId === seatId); // a seat's meter moves with that seat's runs only
    w.solo = sameMeter.length === 0;
    for (const o of sameMeter) o.solo = false;
    return w;
  }

  /** Called as a worker ends: teach the estimator what it cost and how far the 5-hour meter moved. */
  learn(w: RunWatch, costUsd: number): void {
    if (this.mode === 'off' || !(costUsd > 0)) return;
    const at = Date.now();
    const seat = w.seatId != null ? { seat: w.seatId } : {};
    const plain = () => recordRunStats(this.db, w.model, w.effort, { usd: costUsd, pct: null, at, ...seat });
    if (!w.solo || w.startPct == null) return plain();
    // A seat's meter moves with that seat's runs only, so "solo" is per seat; the read uses the seat's own login.
    const read = w.seatId != null ? seatNow(this.db, w.seatId) : getUsageSnapshot({ db: this.db, force: true });
    void read
      .then((snap) => {
        const s = snap.windows.find((x) => x.id === 'session');
        const same = s && s.resetsAt === w.resetsAt && s.percentUsed != null && s.percentUsed >= w.startPct!;
        recordRunStats(this.db, w.model, w.effort, { usd: costUsd, pct: same ? s!.percentUsed! - w.startPct! : null, at, ...seat });
      })
      .catch(plain);
  }
}

export { readLast };

function peekSeatSnapshot(db: Database, seatId: number): UsageSnapshot {
  return buildSnapshot(db, Date.now(), null, STALE_AFTER_MS, seatScope(seatId));
}

/** A fresh read of one seat's meter, or its cached one when the seat is gone. */
async function seatNow(db: Database, seatId: number): Promise<UsageSnapshot> {
  const seat = db.query<{ project_id: number }, [number]>('SELECT project_id FROM seats WHERE id = ?').get(seatId);
  const s = seat ? listSeats(db, seat.project_id).find((x) => x.id === seatId) : null;
  return s ? (await seatUsage(db, s, { force: true })).snapshot : peekSeatSnapshot(db, seatId);
}
