import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatch } from '../src/cli/dispatch.ts';
import { closeDb, openDb } from '../src/db/db.ts';
import { createProject, createTicket, getTicketById } from '../src/db/queries.ts';
import { fakeRunner } from '../src/orchestrator/fake.ts';
import { Orchestrator } from '../src/orchestrator/scheduler.ts';
import { readLast } from '../src/sched/policy.ts';
import { recordRunStats, setSchedMode } from '../src/sched/stats.ts';
import { lendLog, NO_ONE, windowOpen } from '../src/team/lend.ts';
import { addMember, addSeat, getSeat, setLend } from '../src/team/store.ts';

const H = 3_600_000;
const raw = (five: number) => ({
  subscription_type: 'team',
  rate_limits_available: true,
  rate_limits: { five_hour: { utilization: five, resets_at: new Date(Date.now() + 2 * H).toISOString() }, seven_day: { utilization: 10, resets_at: new Date(Date.now() + 70 * H).toISOString() } },
});

let home: string;
let logs: string[];
const realLog = console.log;
const saved: Record<string, string | undefined> = {};
const KEYS = ['SALU_HOME', 'SALU_WORKER', 'SALU_SCHED', 'SALU_FAKE_SEAT_USAGE', 'SALU_USER'];

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  home = mkdtempSync(join(tmpdir(), 'salu-lend-'));
  mkdirSync(join(home, 'web'));
  process.env.SALU_HOME = join(home, 'h');
  process.env.SALU_WORKER = 'fake';
  delete process.env.SALU_SCHED;
  closeDb();
  logs = [];
  console.log = (...a: unknown[]) => void logs.push(a.join(' '));
});
afterEach(() => {
  console.log = realLog;
  closeDb();
  rmSync(home, { recursive: true, force: true });
  for (const k of KEYS) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
});

/** alice's seat is nearly full, bob's is empty; an Opus ticket costs about 30% of a window. */
function setup() {
  const db = openDb();
  const p = createProject(db, { name: 'web', path: join(home, 'web') });
  addMember(db, p.id, 'alice');
  addMember(db, p.id, 'bob');
  addSeat(db, p.id, 'alice-team', { owner: 'alice' });
  addSeat(db, p.id, 'bob-team', { owner: 'bob' });
  for (let i = 0; i < 5; i++) recordRunStats(db, 'claude-opus-5-5', 'medium', { usd: 1.5, pct: 30, at: Date.now() });
  setSchedMode(db, 'on');
  process.env.SALU_FAKE_SEAT_USAGE = JSON.stringify({ 'alice-team': raw(80), 'bob-team': raw(10) });
  const t = (name: string, by = 'alice') => createTicket(db, { status: 'todo', project_id: p.id, name, query: 'FAKE:done', labels: [`by-${by}`] });
  return { db, p, t };
}
const run = (db: ReturnType<typeof openDb>, ms = 0) => {
  const o = new Orchestrator({ db, concurrency: 1, exitWhenEmpty: ms === 0, heartbeatMs: 100, runner: fakeRunner });
  const started = o.start();
  return ms ? Bun.sleep(ms).then(() => o.stop?.()).then(() => started) : started;
};
const plain = () => logs.join('\n').replace(/\x1b\[[0-9;]*m/g, '');

describe('borrowing spare seat time', () => {
  test('off by default: a ticket that does not fit its own seat waits, and says the lender is not lending', async () => {
    const { db, t } = setup();
    const x = t('big');
    await dispatch(['sched']);
    await run(db, 400);
    expect(getTicketById(db, x.id)!.status).toBe('todo');
    expect(readLast(db)!.hold?.reason).toMatch(/bob's seat and bob has not lent it/);
    expect(lendLog(db, 1)).toEqual([]);
  });

  test('lending on: the ticket starts on the lender\'s seat and is logged with lender and cost', async () => {
    const { db, p, t } = setup();
    setLend(db, p.id, 'bob-team', true, { cap: 50 });
    const x = t('big');
    await dispatch(['sched']);
    await run(db);
    const done = getTicketById(db, x.id)!;
    expect(done.status).toBe('done');
    expect(done.seat_id).toBe(getSeat(db, p.id, 'bob-team')!.id);
    const rows = lendLog(db, p.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ticket: 'big', lender: 'bob', borrower: 'alice', seat: 'bob-team' });
    expect(rows[0]!.est_pct).toBeGreaterThan(0);
    logs = [];
    await dispatch(['seat', 'lent']);
    expect(plain()).toMatch(/big\s+bob\s+alice\s+bob-team/);
  });

  test('a ticket with room on its own seat never borrows', async () => {
    const { db, p, t } = setup();
    setLend(db, p.id, 'bob-team', true);
    process.env.SALU_FAKE_SEAT_USAGE = JSON.stringify({ 'alice-team': raw(10), 'bob-team': raw(0) });
    const x = t('small');
    await dispatch(['sched']);
    await run(db);
    expect(getTicketById(db, x.id)!.seat_id).toBe(getSeat(db, p.id, 'alice-team')!.id);
    expect(lendLog(db, p.id)).toEqual([]);
  });

  test('the cap holds: borrowed tickets in the last 5 hours may not pass it', async () => {
    const { db, p, t } = setup();
    setLend(db, p.id, 'bob-team', true, { cap: 40 }); // one ticket (~30%) fits, a second (60%) does not
    const one = t('one');
    await dispatch(['sched']);
    await run(db);
    expect(getTicketById(db, one.id)!.status).toBe('done');
    const two = t('two');
    await dispatch(['sched']);
    await run(db, 400);
    expect(getTicketById(db, two.id)!.status).toBe('todo');
    expect(readLast(db)!.hold?.reason).toMatch(/lending cap is used/);
    expect(lendLog(db, p.id)).toHaveLength(1);
  });

  test('outside the lending window nothing is borrowed', async () => {
    const { db, p, t } = setup();
    const h = new Date().getHours();
    setLend(db, p.id, 'bob-team', true, { from: (h + 2) % 24, to: (h + 4) % 24 });
    const x = t('big');
    await dispatch(['sched']);
    await run(db, 400);
    expect(getTicketById(db, x.id)!.status).toBe('todo');
    expect(readLast(db)!.hold?.reason).toMatch(/lending is closed now/);
  });

  test('a ticket with no named requester (shared key) borrows only a seat that is lent, and is logged as unnamed', async () => {
    const { db, p } = setup();
    process.env.SALU_FAKE_SEAT_USAGE = JSON.stringify({ 'alice-team': raw(80), 'bob-team': raw(10) });
    const x = createTicket(db, { status: 'todo', project_id: p.id, name: 'anon', query: 'FAKE:done' }); // alice is the admin: her seat is its own, but it is full
    await dispatch(['sched']);
    await run(db, 400);
    expect(getTicketById(db, x.id)!.status).toBe('todo');
    setLend(db, p.id, 'bob-team', true);
    await run(db);
    expect(getTicketById(db, x.id)!.seat_id).toBe(getSeat(db, p.id, 'bob-team')!.id);
    expect(lendLog(db, p.id)[0]).toMatchObject({ ticket: 'anon', lender: 'bob', borrower: NO_ONE });
  });

  test('windowOpen wraps past midnight', () => {
    const at = (h: number) => new Date(2026, 9, 3, h, 30).getTime();
    expect(windowOpen({ lend_from: 22, lend_to: 7 }, at(23))).toBe(true);
    expect(windowOpen({ lend_from: 22, lend_to: 7 }, at(3))).toBe(true);
    expect(windowOpen({ lend_from: 22, lend_to: 7 }, at(12))).toBe(false);
    expect(windowOpen({ lend_from: null, lend_to: null }, at(12))).toBe(true);
  });

  test('a ticket that stays on a lent seat stops when the lender stops lending', async () => {
    const { db, p, t } = setup();
    setLend(db, p.id, 'bob-team', true);
    const x = t('resume');
    db.query('UPDATE tickets SET seat_id = ? WHERE id = ?').run(getSeat(db, p.id, 'bob-team')!.id, x.id);
    setLend(db, p.id, 'bob-team', false);
    await dispatch(['sched']);
    await run(db, 400);
    expect(getTicketById(db, x.id)!.status).toBe('todo');
  });

  test('only the seat\'s owner switches lending on; the warning is printed', async () => {
    const { p, db } = setup();
    process.env.SALU_USER = 'alice';
    await expect(dispatch(['seat', 'lend', 'bob-team', 'on'])).rejects.toThrow(/only bob can switch lending on/);
    expect(getSeat(db, p.id, 'bob-team')!.lend).toBe(0);
    process.env.SALU_USER = 'bob';
    await dispatch(['seat', 'lend', 'bob-team', 'on', '--cap', '25', '--from', '22', '--to', '7']);
    const out = plain();
    expect(out).toContain('lends up to 25%');
    expect(out).toContain('22:00 to 7:00');
    expect(out).toMatch(/NOT been checked at the source/);
    expect(out).toMatch(/lender's choice|your responsibility/);
    // anyone may switch it off
    process.env.SALU_USER = 'alice';
    await dispatch(['seat', 'lend', 'bob-team', 'off']);
    expect(getSeat(db, p.id, 'bob-team')!.lend).toBe(0);
  });
});
