import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/db.ts';
import {
  buildSnapshot,
  classifyFetchError,
  formatUsageHeader,
  formatUsageLines,
  getUsageSnapshot,
  onUsageChange,
  parseUsage,
  peekUsageSnapshot,
  resetUsageCache,
  recordRateLimitEvent,
  sdkFetcher,
  usageBar,
  watchUsage,
} from '../src/usage/index.ts';
import type { UsageFetch, UsageFetcher } from '../src/usage/index.ts';

const NOW = Date.UTC(2026, 8, 30, 15, 0, 0);
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

const SUB_USAGE = {
  session: { total_cost_usd: 0.1 },
  subscription_type: 'max',
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 62, resets_at: iso(NOW + 2 * H) },
    seven_day: { utilization: 31.4, resets_at: iso(NOW + 72 * H) },
    seven_day_opus: { utilization: 100, resets_at: iso(NOW + 72 * H) },
    seven_day_sonnet: null,
    model_scoped: [{ display_name: 'Fable', utilization: 5, resets_at: iso(NOW + 72 * H) }],
  },
};
const API_KEY_USAGE = { session: {}, subscription_type: null, rate_limits_available: false, rate_limits: null };

let home: string;
let db: ReturnType<typeof openDb>;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'salu-usnap-'));
  process.env.SALU_HOME = home;
  db = openDb();
});
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

function fresh() {
  db.run("DELETE FROM state WHERE key LIKE 'usage_%'");
  resetUsageCache(db);
  return db;
}
function fetcherOf(r: UsageFetch | (() => UsageFetch), counter = { n: 0 }): UsageFetcher & { counter: { n: number } } {
  const f: any = async () => {
    counter.n++;
    return typeof r === 'function' ? r() : r;
  };
  f.counter = counter;
  return f;
}

describe('parseUsage', () => {
  test('subscription windows, in order, with percent used and left', () => {
    const r = parseUsage(SUB_USAGE, NOW);
    expect(r.ok).toBe(true);
    expect(r.plan).toBe('max');
    expect(r.windows.map((w) => w.id)).toEqual(['session', 'weekly', 'opus', 'fable']);
    const s = r.windows[0]!;
    expect(s).toMatchObject({ short: '5h', percentUsed: 62, percentLeft: 38, status: 'allowed', resetsAt: NOW + 2 * H });
    expect(r.windows[1]!.percentUsed).toBe(31);
    expect(r.windows[2]).toMatchObject({ percentUsed: 100, percentLeft: 0, status: 'rejected' });
    expect(r.windows[3]!.label).toBe('Weekly · Fable');
  });
  test('API key / third-party auth is unavailable with a reason', () => {
    const r = parseUsage(API_KEY_USAGE, NOW);
    expect(r).toMatchObject({ ok: false, reasonKind: 'no-subscription' });
  });
  test('garbage is an error, not a throw', () => {
    expect(parseUsage(null, NOW).ok).toBe(false);
    expect(parseUsage({ rate_limits_available: true, rate_limits: {} }, NOW).ok).toBe(false);
  });
  test('an unknown per-model window gets a model: id', () => {
    const r = parseUsage({ rate_limits_available: true, rate_limits: { model_scoped: [{ display_name: 'Haiku', utilization: 10, resets_at: null }] } }, NOW);
    expect(r.windows[0]!.id).toBe('model:haiku');
  });
});

describe('classifyFetchError', () => {
  test('login, network, other', () => {
    expect(classifyFetchError(new Error('401 Unauthorized')).reasonKind).toBe('not-logged-in');
    expect(classifyFetchError(new Error('usage read timed out after 30000 ms')).reasonKind).toBe('offline');
    expect(classifyFetchError(new Error('boom')).reasonKind).toBe('error');
  });
});

describe('snapshot cache', () => {
  test('reads once per minute, refresh on request only after the interval', async () => {
    fresh();
    const f = fetcherOf(parseUsage(SUB_USAGE, NOW));
    const a = await getUsageSnapshot({ db, fetcher: f, now: NOW });
    expect(a.available).toBe(true);
    expect(a.stale).toBe(false);
    expect(a.windows[0]!.percentUsed).toBe(62);
    await getUsageSnapshot({ db, fetcher: f, now: NOW + 30_000 });
    expect(f.counter.n).toBe(1);
    await getUsageSnapshot({ db, fetcher: f, now: NOW + 61_000 });
    expect(f.counter.n).toBe(2);
    await getUsageSnapshot({ db, fetcher: f, now: NOW + 62_000, force: true });
    expect(f.counter.n).toBe(3);
    await getUsageSnapshot({ db, fetcher: f, now: NOW + 200_000, refresh: false });
    expect(f.counter.n).toBe(3);
  });

  test('concurrent callers share one read', async () => {
    fresh();
    const f = fetcherOf(parseUsage(SUB_USAGE, NOW));
    await Promise.all([getUsageSnapshot({ db, fetcher: f, now: NOW }), getUsageSnapshot({ db, fetcher: f, now: NOW }), getUsageSnapshot({ db, fetcher: f, now: NOW })]);
    expect(f.counter.n).toBe(1);
  });

  test('API-key auth: available false with reason, and it is not retried within the minute', async () => {
    fresh();
    const f = fetcherOf(parseUsage(API_KEY_USAGE, NOW));
    const s = await getUsageSnapshot({ db, fetcher: f, now: NOW });
    expect(s).toMatchObject({ available: false, reasonKind: 'no-subscription', windows: [] });
    expect(s.reason).toContain('API key');
    await getUsageSnapshot({ db, fetcher: f, now: NOW + 1000 });
    expect(f.counter.n).toBe(1);
  });

  test('a failed read with no earlier data is unavailable (offline / not logged in)', async () => {
    fresh();
    const s = await getUsageSnapshot({ db, fetcher: fetcherOf({ ok: false, at: NOW, plan: null, windows: [], reasonKind: 'offline', reason: 'Could not reach Claude' }), now: NOW });
    expect(s).toMatchObject({ available: false, reasonKind: 'offline', reason: 'Could not reach Claude' });
  });

  test('a failed read after a good one keeps the numbers, flags stale, reports the error', async () => {
    fresh();
    await getUsageSnapshot({ db, fetcher: fetcherOf(parseUsage(SUB_USAGE, NOW)), now: NOW });
    const s = await getUsageSnapshot({ db, fetcher: fetcherOf({ ok: false, at: NOW + 2 * 60_000, plan: null, windows: [], reasonKind: 'offline', reason: 'Could not reach Claude' }), now: NOW + 2 * 60_000 });
    expect(s.available).toBe(true);
    expect(s.stale).toBe(true);
    expect(s.error).toBe('Could not reach Claude');
    expect(s.windows[0]!.percentUsed).toBe(62);
  });

  test('a fetcher that throws never throws out', async () => {
    fresh();
    const f: UsageFetcher = async () => {
      throw new Error('kaboom');
    };
    const s = await getUsageSnapshot({ db, fetcher: f, now: NOW });
    expect(s.available).toBe(false);
  });

  test('old data is stale even without an error', async () => {
    fresh();
    await getUsageSnapshot({ db, fetcher: fetcherOf(parseUsage(SUB_USAGE, NOW)), now: NOW });
    expect(buildSnapshot(db, NOW + 10 * 60_000).stale).toBe(true);
    expect(peekUsageSnapshot(db, NOW + 60_000).stale).toBe(false);
  });

  test('a window whose reset time passed starts over', async () => {
    fresh();
    await getUsageSnapshot({ db, fetcher: fetcherOf(parseUsage(SUB_USAGE, NOW)), now: NOW });
    const s = buildSnapshot(db, NOW + 3 * H);
    const w = s.windows.find((x) => x.id === 'session')!;
    expect(w).toMatchObject({ percentUsed: 0, status: 'allowed', resetsAt: null });
    expect(s.windows.find((x) => x.id === 'weekly')!.percentUsed).toBe(31);
  });
});

describe('worker rate_limit_events', () => {
  test('an event alone makes a snapshot, with status and reset', () => {
    fresh();
    expect(recordRateLimitEvent(db, { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.85, resetsAt: Math.floor((NOW + H) / 1000) } }, NOW)).toBe(true);
    const s = buildSnapshot(db, NOW + 1000);
    expect(s.available).toBe(true);
    expect(s.windows[0]).toMatchObject({ id: 'session', percentUsed: 85, status: 'warning', resetsAt: NOW + H, source: 'event' });
  });

  test('a rejected event without utilization reads as 100%', () => {
    fresh();
    recordRateLimitEvent(db, { status: 'rejected', rateLimitType: 'seven_day_opus', resetsAt: Math.floor((NOW + H) / 1000) }, NOW);
    expect(buildSnapshot(db, NOW).windows[0]).toMatchObject({ id: 'opus', percentUsed: 100, percentLeft: 0, status: 'rejected' });
  });

  test('the newer observation wins per window; last seen per window is kept', async () => {
    fresh();
    await getUsageSnapshot({ db, fetcher: fetcherOf(parseUsage(SUB_USAGE, NOW)), now: NOW });
    recordRateLimitEvent(db, { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.7, resetsAt: Math.floor((NOW + 2 * H) / 1000) }, NOW + 5000);
    recordRateLimitEvent(db, { status: 'allowed', rateLimitType: 'seven_day', utilization: 0.4 }, NOW - 5000); // older than the read
    const s = buildSnapshot(db, NOW + 6000);
    expect(s.windows.find((w) => w.id === 'session')).toMatchObject({ percentUsed: 70, source: 'event' });
    expect(s.windows.find((w) => w.id === 'weekly')).toMatchObject({ percentUsed: 31, source: 'usage' });
  });

  test('unifiedWindows fills the other windows', () => {
    fresh();
    recordRateLimitEvent(db, { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.2, unifiedWindows: { five_hour: { utilization: 0.2, resetsAt: 1 }, seven_day: { utilization: 0.5, resetsAt: Math.floor((NOW + H) / 1000) } } }, NOW);
    expect(buildSnapshot(db, NOW).windows.map((w) => [w.id, w.percentUsed])).toEqual([
      ['session', 20],
      ['weekly', 50],
    ]);
  });

  test('junk events are ignored', () => {
    fresh();
    expect(recordRateLimitEvent(db, null)).toBe(false);
    expect(recordRateLimitEvent(db, { type: 'rate_limit_event' })).toBe(false);
    expect(recordRateLimitEvent(db, { status: 'allowed' })).toBe(false);
  });

  test('an event forces a re-read inside the minute and notifies subscribers', async () => {
    fresh();
    const f = fetcherOf(parseUsage(SUB_USAGE, NOW));
    await getUsageSnapshot({ db, fetcher: f, now: NOW });
    let calls = 0;
    const off = onUsageChange(() => calls++);
    recordRateLimitEvent(db, { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.9 }, NOW + 10_000);
    expect(calls).toBe(1);
    await getUsageSnapshot({ db, fetcher: f, now: NOW + 10_000 });
    expect(f.counter.n).toBe(2);
    expect(calls).toBe(2); // and again when the read finished
    off();
  });
});

describe('watchUsage', () => {
  test('calls back with the cache, then with the read, and stops', async () => {
    fresh();
    const seen: boolean[] = [];
    const stop = watchUsage(db, (s) => seen.push(s.available), { fetcher: fetcherOf(parseUsage(SUB_USAGE, Date.now())), pollMs: 20 });
    await new Promise((r) => setTimeout(r, 100));
    stop();
    expect(seen[0]).toBe(false);
    expect(seen.at(-1)).toBe(true);
    const n = seen.length;
    await new Promise((r) => setTimeout(r, 60));
    expect(seen.length).toBe(n);
  });
});

describe('sdkFetcher', () => {
  test('reads usage through the SDK query without a turn', async () => {
    let prompts = 0;
    const q: any = ({ prompt }: any) => {
      prompts++;
      void prompt;
      return { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => SUB_USAGE, close() {} };
    };
    const r = await sdkFetcher({ queryFn: q })();
    expect(r.ok).toBe(true);
    expect(r.windows[0]!.id).toBe('session');
    expect(prompts).toBe(1);
  });
  test('a session without a usage method is a soft failure', async () => {
    const q: any = () => ({ close() {} });
    const r = await sdkFetcher({ queryFn: q })();
    expect(r.ok).toBe(false);
  });
});

describe('text', () => {
  test('bar and header meter', () => {
    expect(usageBar(0)).toBe('▱▱▱▱▱');
    expect(usageBar(62)).toBe('▰▰▰▱▱');
    expect(usageBar(100)).toBe('▰▰▰▰▰');
    expect(usageBar(null)).toBe('▱▱▱▱▱');
    fresh();
    recordRateLimitEvent(db, { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.62, resetsAt: Math.floor((NOW + H) / 1000) }, NOW);
    const s = buildSnapshot(db, NOW);
    expect(formatUsageHeader(s, NOW)).toMatch(/^5h ▰▰▰▱▱ 62% · resets \d{1,2}:\d{2}[ap]m$/);
  });
  test('header with weekly, stale, unavailable', async () => {
    fresh();
    await getUsageSnapshot({ db, fetcher: fetcherOf(parseUsage(SUB_USAGE, NOW)), now: NOW });
    const h = formatUsageHeader(buildSnapshot(db, NOW), NOW);
    expect(h).toContain('5h ▰▰▰▱▱ 62%');
    expect(h).toContain('week ▰▰▱▱▱ 31%');
    expect(formatUsageHeader(buildSnapshot(db, NOW + 10 * 60_000), NOW + 10 * 60_000)).toContain('(stale)');
    fresh();
    expect(formatUsageHeader(buildSnapshot(db, NOW))).toBe('usage n/a');
  });
  test('lines for salu usage', async () => {
    fresh();
    await getUsageSnapshot({ db, fetcher: fetcherOf(parseUsage(SUB_USAGE, NOW)), now: NOW });
    const lines = formatUsageLines(buildSnapshot(db, NOW), NOW);
    expect(lines[0]).toBe('plan max');
    expect(lines[1]).toContain('Session (5 hours)');
    expect(lines[1]).toContain('62% used, 38% left');
    expect(lines.join('\n')).toContain('blocked');
    fresh();
    expect(formatUsageLines(buildSnapshot(db, NOW))[0]).toContain('unavailable');
  });
});
