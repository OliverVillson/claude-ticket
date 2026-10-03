import type { Database } from 'bun:sqlite';
import { getState, setState } from '../db/queries.ts';

/**
 * What a ticket costs, learned from finished runs. Stored in the `state` table (no schema change).
 * The unit is API-equivalent dollars (`runs.cost_usd`, exact per ticket); a second number,
 * plan-percent per dollar, is learned from how far the 5-hour meter moved while a ticket ran alone,
 * so a dollar estimate can be turned into "about 4% of the window".
 */

export const SCHED_STATE = {
  mode: 'sched_mode', // 'off' | 'advise' | 'on'
  stats: 'sched_stats', // JSON: { "<family>|<effort>": Sample[] }
  skips: 'sched_skips', // JSON: { "<ticketId>": times a later ticket was started ahead of it }
  last: 'sched_last', // JSON: SchedLast, the latest decision (for `salu sched`)
} as const;

export type SchedMode = 'off' | 'advise' | 'on';

export interface Sample {
  usd: number;
  /** Plan-percent the 5-hour window moved during the run; null when it could not be attributed. */
  pct: number | null;
  at: number;
  /** The seat the run used (v2); absent for runs on the machine's own login. */
  seat?: number;
}

export const MAX_SAMPLES = 20;
/** Samples a (model, effort) pair needs before its own median replaces the built-in guess. */
export const LEARNED_AFTER = 5;
/** Samples carrying a percent that the percent-per-dollar ratio needs before it is trusted. */
export const RATIO_AFTER = 3;

export function schedMode(db: Database): SchedMode {
  const v = (getState(db, SCHED_STATE.mode) ?? process.env.SALU_SCHED ?? 'advise').toLowerCase();
  return v === 'off' || v === 'on' ? v : 'advise';
}

export function setSchedMode(db: Database, m: SchedMode): void {
  setState(db, SCHED_STATE.mode, m);
}

/** `claude-opus-5-5` / `opus` -> `opus`; unknown ids stay as they are. */
export function modelFamily(model: string | null | undefined): string {
  const m = (model ?? '').toLowerCase();
  for (const f of ['opus', 'sonnet', 'haiku', 'fable']) if (m.includes(f)) return f;
  return m || 'default';
}

export const statKey = (model: string | null | undefined, effort: string | null | undefined) => `${modelFamily(model)}|${effort ?? 'medium'}`;

type Stats = Record<string, Sample[]>;

function readJson<T>(db: Database, key: string, fallback: T): T {
  try {
    const v = JSON.parse(getState(db, key) ?? '');
    return v && typeof v === 'object' ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

export function readStats(db: Database): Stats {
  return readJson<Stats>(db, SCHED_STATE.stats, {});
}

export function recordRunStats(db: Database, model: string | null | undefined, effort: string | null | undefined, s: Sample): void {
  if (!(s.usd > 0)) return; // fake runs and failures that cost nothing teach nothing
  const all = readStats(db);
  const k = statKey(model, effort);
  all[k] = [...(all[k] ?? []), s].slice(-MAX_SAMPLES);
  setState(db, SCHED_STATE.stats, JSON.stringify(all));
}

/** Built-in guesses (dollars at medium effort), used until a pair has run enough times. */
const GUESS_USD: Record<string, number> = { opus: 1.5, sonnet: 0.6, haiku: 0.15, fable: 2.5, default: 1.5 };
const EFFORT_FACTOR: Record<string, number> = { low: 0.6, medium: 1, high: 1.6, xhigh: 2.4, max: 3.2 };

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export interface Estimate {
  usd: number;
  /** Plan-percent of the 5-hour window, or null until the ratio has been learned. */
  pct: number | null;
  /** Finished runs behind the dollar number; 0 means the built-in guess. */
  samples: number;
  learned: boolean;
}

/** Plan-percent per dollar, pooled over every attributed run (only one seat's runs when `seatId` is given: seats differ in plan size). Null until {@link RATIO_AFTER} of them exist. */
export function percentPerUsd(db: Database, stats: Stats = readStats(db), seatId?: number): number | null {
  let pct = 0;
  let usd = 0;
  let n = 0;
  for (const list of Object.values(stats))
    for (const s of list)
      if (s.pct != null && s.usd > 0 && (seatId == null || s.seat === seatId)) {
        pct += s.pct;
        usd += s.usd;
        n++;
      }
  return n >= RATIO_AFTER && usd > 0 && pct > 0 ? pct / usd : null;
}

export function estimateTicket(db: Database, model: string | null | undefined, effort: string | null | undefined, stats: Stats = readStats(db), seatId?: number): Estimate {
  const fam = modelFamily(model);
  const own = (stats[statKey(model, effort)] ?? []).filter((s) => s.usd > 0);
  const learned = own.length >= LEARNED_AFTER;
  const usd = learned ? median(own.map((s) => s.usd)) : (GUESS_USD[fam] ?? GUESS_USD.default!) * (EFFORT_FACTOR[effort ?? 'medium'] ?? 1);
  const ratio = (seatId != null ? percentPerUsd(db, stats, seatId) : null) ?? percentPerUsd(db, stats);
  return { usd, pct: ratio == null ? null : usd * ratio, samples: own.length, learned };
}

/** Dollars spent by runs started in the last 24 hours. */
export function spentLast24h(db: Database, now = Date.now()): number {
  return db.query<{ s: number | null }, [number]>('SELECT SUM(cost_usd) AS s FROM runs WHERE started_at >= ?').get(now - 86_400_000)?.s ?? 0;
}

/** SALU_BUDGET_USD_PER_DAY as a number, or null when unset. */
export function dailyBudgetUsd(): number | null {
  const n = Number(process.env.SALU_BUDGET_USD_PER_DAY);
  return Number.isFinite(n) && n > 0 ? n : null;
}
