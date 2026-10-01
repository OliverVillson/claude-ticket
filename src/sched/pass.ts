import type { Database } from 'bun:sqlite';
import type { TicketView } from '../db/types.ts';
import { formatResetTime } from '../usage/format.ts';
import { getUsageSnapshot, peekUsageSnapshot, type UsageSnapshot } from '../usage/snapshot.ts';
import { decide, noteStarted, plan, readLast, routeQueued, saveLast, type Decision, type SchedLast } from './policy.ts';
import { recordRunStats, schedMode, type SchedMode } from './stats.ts';

/** What one worker run teaches the estimator. Held on the orchestrator's entry for the run. */
export interface RunWatch {
  model: string;
  effort: string;
  startPct: number | null;
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
      const d = decide(this.db, cands, this.snap, this.now);
      this.decision = d;
      this.wouldPick = d.pick?.name ?? null;
      return this.mode === 'on' ? d.pick : (cands[0] ?? null);
    } catch (e: any) {
      this.log('warn', `scheduler policy skipped: ${String(e?.message ?? e)}`);
      return cands[0] ?? null;
    }
  };

  started(t: TicketView): void {
    if (this.mode === 'on' && this.decision) noteStarted(this.db, this.decision, t.id);
  }

  /** Save the decision for `salu sched`; returns when a held queue may start (epoch ms) or null. */
  end(): number | null {
    if (this.mode === 'off') return null;
    const hold = this.mode === 'on' ? (this.decision?.hold ?? null) : null;
    const last: SchedLast = {
      at: this.now,
      mode: this.mode,
      wouldPick: this.wouldPick,
      hold: this.decision?.hold ?? null,
      skipped: (this.decision?.skipped ?? []).map(({ name, why }) => ({ name, why })),
      routed: this.routed,
    };
    const key = JSON.stringify({ ...last, at: 0 });
    if (key !== this.lastSaved) {
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
    const p = plan(this.db, t);
    const session = this.mode === 'off' ? undefined : (this.snap ?? peekUsageSnapshot(this.db)).windows.find((w) => w.id === 'session');
    const w: RunWatch = { model: p.model, effort: p.effort, startPct: session?.percentUsed ?? null, resetsAt: session?.resetsAt ?? null, solo: others.length === 0 };
    for (const o of others) o.solo = false;
    return w;
  }

  /** Called as a worker ends: teach the estimator what it cost and how far the 5-hour meter moved. */
  learn(w: RunWatch, costUsd: number): void {
    if (this.mode === 'off' || !(costUsd > 0)) return;
    const at = Date.now();
    const plain = () => recordRunStats(this.db, w.model, w.effort, { usd: costUsd, pct: null, at });
    if (!w.solo || w.startPct == null) return plain();
    void getUsageSnapshot({ db: this.db, force: true })
      .then((snap) => {
        const s = snap.windows.find((x) => x.id === 'session');
        const same = s && s.resetsAt === w.resetsAt && s.percentUsed != null && s.percentUsed >= w.startPct!;
        recordRunStats(this.db, w.model, w.effort, { usd: costUsd, pct: same ? s!.percentUsed! - w.startPct! : null, at });
      })
      .catch(plain);
  }
}

export { readLast };
