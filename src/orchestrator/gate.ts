/**
 * The seam between the dispatch loop and the usage-window module (`src/usage/`).
 *
 * The loop never decides on its own whether the 5-hour, weekly or per-model window is open. It
 * asks these three hooks; the defaults call the usage module, which keeps the pause in the
 * `state` table so `ticket pause` / `ticket resume`, `ticket status` and the TUI all see the same
 * thing. Tests replace any hook to skip the probe or shorten the wait.
 */
import type { Database } from 'bun:sqlite';
import type { TicketView } from '../db/types.ts';
import { clearPause as usageClearPause, enterPause, getPause, resumeIfDue } from '../usage/index.ts';
import type { LimitHit, PauseState } from '../usage/types.ts';
import type { PauseInfo } from './status.ts';
import type { WorkerRunner } from './types.ts';

export interface ResumeOutcome {
  /** True when the pause was lifted (the window is open, or the hook decided to go ahead). */
  resumed: boolean;
  /** Free text for the log, e.g. what the probe found. */
  detail?: string;
}

export interface UsageHooks {
  /** The pause holding dispatch right now, or null. `models` non-empty = only those models are held. */
  currentPause(db: Database, now: number): PauseInfo | null;
  /** A worker reported a usage limit: record the pause. */
  onLimitHit(db: Database, hit: LimitHit, ticket: TicketView, now: number): void | Promise<void>;
  /**
   * The pause's reset time has passed. Confirm the window is open and clear the pause, or push
   * the reset time out. The loop re-reads the pause afterwards, so the hook owns the state change.
   */
  resumeIfDue(db: Database, pause: PauseInfo, runner: WorkerRunner, now: number): Promise<ResumeOutcome>;
}

/** The usage module's `PauseState` in the core's `PauseInfo` shape (what `readStatus` and the TUI use). */
export function toPauseInfo(s: PauseState | null): PauseInfo | null {
  if (!s) return null;
  return {
    until: s.manual || !(s.until > 0) ? null : s.until,
    reason: s.reason,
    kind: s.kind,
    models: s.models,
    manual: s.manual,
  };
}

/** Grace after a reported reset before probing. Tests shorten it with TICKET_RESUME_MARGIN_MS. */
function marginMs(): number | undefined {
  const v = Number(process.env.TICKET_RESUME_MARGIN_MS);
  return process.env.TICKET_RESUME_MARGIN_MS !== undefined && Number.isFinite(v) && v >= 0 ? v : undefined;
}

export const defaultHooks: UsageHooks = {
  currentPause(db) {
    return toPauseInfo(getPause(db));
  },
  onLimitHit(db, hit, _ticket, now) {
    enterPause(db, hit, { now, margin: marginMs() });
  },
  async resumeIfDue(db, _pause, runner) {
    const lines: string[] = [];
    const r = await resumeIfDue(db, {
      margin: marginMs(),
      log: (l) => lines.push(l),
      // The runner's probe: one cheap real turn for the SDK, the env/file switch for the fake.
      probe: async (state) => {
        const p = await runner.probe(state.models[0] ?? null);
        if (p === 'ok') return { status: 'open', detail: `${runner.name} probe: window open` };
        if (p.resetsAt || p.kind !== 'unknown') return { status: 'closed', hit: p, detail: p.raw.slice(0, 200) };
        return { status: 'unknown', detail: p.raw.slice(0, 200) };
      },
    });
    // Null means the pause was extended (window still closed or the probe was inconclusive).
    return { resumed: !!r, detail: lines.join(' · ') || undefined };
  },
};

export function resolveHooks(h?: Partial<UsageHooks>): UsageHooks {
  return { ...defaultHooks, ...(h ?? {}) };
}

/** Lift every pause (limit and manual). What `ticket resume` does; here for the loop's `resume()`. */
export function clearPause(db: Database): void {
  usageClearPause(db);
}
