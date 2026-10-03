import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatch } from '../src/cli/dispatch.ts';
import { closeDb, openDb } from '../src/db/db.ts';
import { createProject } from '../src/db/queries.ts';
import { addMember, addSeat, listSeats, setSeatDisabled } from '../src/team/store.ts';
import { saveSeatToken } from '../src/core/seats.ts';
import { formatSeatUsageLines, seatTokenLogin, parseUsage, seatUsage, setSeatLoginResolver, teamUsage } from '../src/usage/index.ts';
import type { UsageFetcher } from '../src/usage/index.ts';
import { estimateTicket, percentPerUsd } from '../src/sched/stats.ts';

const H = 3_600_000;
const raw = (five: number, week: number) => ({
  subscription_type: 'team',
  rate_limits_available: true,
  rate_limits: { five_hour: { utilization: five, resets_at: new Date(Date.now() + 2 * H).toISOString() }, seven_day: { utilization: week, resets_at: new Date(Date.now() + 70 * H).toISOString() } },
});
const ok = (five: number, week: number): UsageFetcher => async () => parseUsage(raw(five, week));
const dead: UsageFetcher = async () => ({ ok: false, at: Date.now(), plan: null, windows: [], reasonKind: 'not-logged-in', reason: 'Not logged in' });

let root: string;
let logs: string[];
const realLog = console.log;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'salu-seatusage-'));
  process.env.SALU_HOME = join(root, 'home');
  delete process.env.SALU_FAKE_SEAT_USAGE;
  closeDb();
  logs = [];
  console.log = (...a: unknown[]) => void logs.push(a.join(' '));
});
afterEach(() => {
  console.log = realLog;
  closeDb();
  rmSync(root, { recursive: true, force: true });
});

function team() {
  const db = openDb();
  const p = createProject(db, { name: 'web', path: join(root, 'web') });
  addMember(db, p.id, 'alice');
  addMember(db, p.id, 'bob');
  addSeat(db, p.id, 'alice-team', { owner: 'alice' });
  addSeat(db, p.id, 'bob-team', { owner: 'bob' });
  return { db, p };
}

describe('per-seat usage', () => {
  test('each seat keeps its own windows', async () => {
    const { db, p } = team();
    const [a, b] = listSeats(db, p.id);
    const ua = await seatUsage(db, a!, { fetcher: ok(62, 31) });
    const ub = await seatUsage(db, b!, { fetcher: ok(5, 90) });
    expect(ua.state).toBe('ok');
    expect(ua.snapshot.windows.find((w) => w.id === 'session')!.percentUsed).toBe(62);
    expect(ub.snapshot.windows.find((w) => w.id === 'session')!.percentUsed).toBe(5);
    // read again from the cache, not mixed up
    const again = await seatUsage(db, a!, { refresh: false });
    expect(again.snapshot.windows.find((w) => w.id === 'weekly')!.percentUsed).toBe(31);
  });

  test('a dead seat is named, the others still read', async () => {
    const { db, p } = team();
    const [a, b] = listSeats(db, p.id);
    const us = await teamUsage(db, p.id, { fetcher: (s) => (s.id === a!.id ? dead : ok(10, 10)) });
    expect(us.map((u) => u.state)).toEqual(['dead', 'ok']);
    const lines = formatSeatUsageLines(us);
    expect(lines[0]).toContain('alice-team');
    expect(lines[0]).toContain('DEAD');
    expect(lines[1]).toContain('10%');
    void b;
  });

  test('a used-up window shows as full; a switched-off seat is not read', async () => {
    const { db, p } = team();
    setSeatDisabled(db, p.id, 'bob-team', true);
    const us = await teamUsage(db, p.id, { fetcher: (s) => (s.label === 'alice-team' ? ok(100, 20) : dead) });
    expect(us[0]!.state).toBe('full');
    expect(us[1]!.state).toBe('off');
  });

  test('no login resolver means no login yet; a resolver supplies it', async () => {
    const { db, p } = team();
    const s = listSeats(db, p.id)[0]!;
    expect((await seatUsage(db, s)).state).toBe('no-login');
    const prev = setSeatLoginResolver(() => null);
    try {
      expect((await seatUsage(db, s)).state).toBe('no-login');
    } finally {
      setSeatLoginResolver(prev);
    }
  });

  test('the default login is the seat token saved on this machine, and only that seat\'s', () => {
    const { db, p } = team();
    const [a, b] = listSeats(db, p.id);
    expect(seatTokenLogin(a!)).toBeNull();
    saveSeatToken(String(a!.id), 'sk-ant-oat01-abcdefgh');
    expect(seatTokenLogin(a!)).toEqual({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-abcdefgh' } });
    expect(seatTokenLogin(b!)).toBeNull();
  });

  test('SALU_FAKE_SEAT_USAGE drives `salu usage` with a meter per seat', async () => {
    const { p } = team();
    process.env.SALU_FAKE_SEAT_USAGE = JSON.stringify({ 'alice-team': raw(62, 31), 'bob-team': 'dead' });
    expect(await dispatch(['usage', '--project', p.name, '--refresh'])).toBe(0);
    const out = logs.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
    expect(out).toContain('alice-team (alice)');
    expect(out).toContain('62%');
    expect(out).toMatch(/bob-team \(bob\)\s+DEAD/);
  });

  test('`salu usage --json` lists seats', async () => {
    const { p } = team();
    process.env.SALU_FAKE_SEAT_USAGE = JSON.stringify({ 'alice-team': raw(1, 2), 'bob-team': 'no-login' });
    await dispatch(['usage', '--project', p.name, '--json']);
    const j = JSON.parse(logs.join('\n'));
    expect(j.map((x: any) => [x.seat, x.state])).toEqual([['alice-team', 'ok'], ['bob-team', 'no-login']]);
  });

  test('a project without seats still shows the machine meter (v1)', async () => {
    const db = openDb();
    const p = createProject(db, { name: 'solo', path: join(root, 'solo') });
    process.env.SALU_WORKER = 'fake';
    try {
      await dispatch(['usage', '--project', p.name, '--refresh']);
    } finally {
      delete process.env.SALU_WORKER;
    }
    expect(logs.join('\n')).toContain('Session (5 hours)');
  });
});

describe('per-seat cost ratio', () => {
  test('a seat learns its own percent per dollar, falling back to the pool', () => {
    const db = openDb();
    const now = Date.now();
    const stats = { 'opus|medium': [1, 2, 3].map((i) => ({ usd: 1, pct: 10, at: now + i, seat: 1 })).concat([1, 2, 3].map((i) => ({ usd: 1, pct: 2, at: now + i, seat: 2 }))) };
    expect(percentPerUsd(db, stats, 1)).toBe(10);
    expect(percentPerUsd(db, stats, 2)).toBe(2);
    expect(percentPerUsd(db, stats, 9)).toBeNull();
    expect(estimateTicket(db, 'opus', 'medium', stats, 2).pct).toBeCloseTo(2);
    expect(estimateTicket(db, 'opus', 'medium', stats, 9).pct).toBeCloseTo(6);
  });
});
