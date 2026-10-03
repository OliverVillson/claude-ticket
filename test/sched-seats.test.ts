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
import { addMember, addSeat, listSeats, setSeatDisabled, setTicketSeat } from '../src/team/store.ts';

const H = 3_600_000;
const raw = (five: number, week = 10) => ({
  subscription_type: 'team',
  rate_limits_available: true,
  rate_limits: { five_hour: { utilization: five, resets_at: new Date(Date.now() + 2 * H).toISOString() }, seven_day: { utilization: week, resets_at: new Date(Date.now() + 70 * H).toISOString() } },
});

let home: string;
let logs: string[];
const realLog = console.log;
const saved: Record<string, string | undefined> = {};
const KEYS = ['SALU_HOME', 'SALU_WORKER', 'SALU_SCHED', 'SALU_FAKE_SEAT_USAGE'];

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  home = mkdtempSync(join(tmpdir(), 'salu-seatsched-'));
  mkdirSync(join(home, 'web'));
  process.env.SALU_HOME = join(home, 'h');
  process.env.SALU_WORKER = 'fake';
  delete process.env.SALU_SCHED;
  delete process.env.SALU_FAKE_SEAT_USAGE;
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

function setup() {
  const db = openDb();
  const p = createProject(db, { name: 'web', path: join(home, 'web') });
  addMember(db, p.id, 'alice');
  addMember(db, p.id, 'bob');
  // The project's own seats (no owner): any ticket may use them. Seats owned by a member are tested below.
  const a = addSeat(db, p.id, 'alice-team');
  const b = addSeat(db, p.id, 'bob-team');
  // finished runs taught the estimator: an Opus ticket costs about 30% of a window
  for (let i = 0; i < 5; i++) recordRunStats(db, 'claude-opus-5-5', 'medium', { usd: 1.5, pct: 30, at: Date.now() });
  setSchedMode(db, 'on');
  const t = (name: string) => createTicket(db, { status: 'todo', project_id: p.id, name, query: 'FAKE:done' });
  return { db, p, a, b, t };
}
const run = (db: ReturnType<typeof openDb>) => new Orchestrator({ db, concurrency: 1, exitWhenEmpty: true, heartbeatMs: 100, runner: fakeRunner }).start();
const plain = () => logs.join('\n').replace(/\x1b\[[0-9;]*m/g, '');

describe('whose seat a ticket may use', () => {
  function owned() {
    const s = setup();
    const aliceOwn = addSeat(s.db, s.p.id, 'alice-own', { owner: 'alice' }); // alice is the admin (first member)
    const bobOwn = addSeat(s.db, s.p.id, 'bob-own', { owner: 'bob' });
    return { ...s, aliceOwn, bobOwn };
  }
  const tk = (db: ReturnType<typeof openDb>, projectId: number, name: string, labels: string[] = []) => createTicket(db, { status: 'todo', project_id: projectId, name, query: 'FAKE:done', labels });

  test("a member's ticket never lands on a teammate's seat, even when it is the emptiest", async () => {
    const { db, p, a, b, bobOwn } = owned();
    process.env.SALU_FAKE_SEAT_USAGE = JSON.stringify({ 'alice-team': raw(90), 'bob-team': raw(90), 'alice-own': raw(0), 'bob-own': raw(50) });
    const x = tk(db, p.id, 'bobs', ['by-bob']);
    await dispatch(['sched']);
    await run(db);
    expect(getTicketById(db, x.id)!.seat_id).toBe(bobOwn.id); // alice-own is emptier but is alice's
    expect([a.id, b.id]).not.toContain(getTicketById(db, x.id)!.seat_id);
    expect(readLast(db)!.placed!.others.map((o) => o.seat)).toContain('alice-own');
  });

  test('a ticket with no author may use the project seats and an admin seat, not a member seat', async () => {
    const { db, p, bobOwn, t } = owned();
    process.env.SALU_FAKE_SEAT_USAGE = JSON.stringify({ 'alice-team': raw(90), 'bob-team': raw(90), 'alice-own': raw(60), 'bob-own': raw(0) });
    const x = t('local');
    await dispatch(['sched']);
    await run(db);
    const seat = getTicketById(db, x.id)!.seat_id;
    expect(seat).not.toBe(bobOwn.id);
    expect(listSeats(db, p.id).find((s) => s.id === seat)!.label).toBe('alice-own');
  });

  test('a seat already on the ticket does not open someone else\'s seat', async () => {
    const { db, p, aliceOwn, tk: _ } = owned() as any;
    process.env.SALU_FAKE_SEAT_USAGE = JSON.stringify({ 'alice-own': raw(0), 'bob-own': raw(0) });
    const x = tk(db, p.id, 'sneaky', ['by-bob']);
    setTicketSeat(db, x.id, aliceOwn.id); // whoever set this, it is not bob's seat
    await dispatch(['sched']);
    const orch = new Orchestrator({ db, concurrency: 1, exitWhenEmpty: true, heartbeatMs: 100, runner: fakeRunner });
    void orch.start();
    await Bun.sleep(400);
    expect(getTicketById(db, x.id)!.status).toBe('todo');
    expect(readLast(db)!.hold!.reason).toMatch(/alice-own: it is alice's seat and alice has not lent it/);
    orch.stop?.();
  });

  test('a by- label that names nobody on the team gets the project seats only', async () => {
    const { db, p, t } = owned();
    process.env.SALU_FAKE_SEAT_USAGE = JSON.stringify({ 'alice-team': raw(50), 'bob-team': raw(90), 'alice-own': raw(0), 'bob-own': raw(0) });
    const x = tk(db, p.id, 'stranger', ['by-mallory']);
    await dispatch(['sched']);
    await run(db);
    expect(listSeats(db, p.id).find((s) => s.id === getTicketById(db, x.id)!.seat_id)!.label).toBe('alice-team');
    void t;
  });
});

describe('seat-aware scheduler', () => {
  test('a ticket that does not fit seat A starts on seat B, and `salu sched` says why', async () => {
    const { db, a, b, t } = setup();
    process.env.SALU_FAKE_SEAT_USAGE = JSON.stringify({ 'alice-team': raw(80), 'bob-team': raw(10) });
    const x = t('big');
    await dispatch(['sched']); // reads both seats
    logs = [];
    await run(db);
    const done = getTicketById(db, x.id)!;
    expect(done.status).toBe('done');
    expect(done.seat_id).toBe(b.id);
    expect(done.seat_id).not.toBe(a.id);
    const last = readLast(db)!;
    expect(last.seat).toBe('bob-team');
    expect(last.placed?.others.map((o) => o.seat)).toEqual(['alice-team']);
    await dispatch(['sched']);
    const out = plain();
    expect(out).toContain('alice-team');
    expect(out).toContain('bob-team');
    expect(out).toMatch(/started big on seat bob-team/);
    expect(out).toMatch(/not on alice-team: needs about 30% of the 5-hour window, 80% is used/);
  });

  test('the queue forecast names the seat each ticket would take', async () => {
    const { t } = setup();
    process.env.SALU_FAKE_SEAT_USAGE = JSON.stringify({ 'alice-team': raw(80), 'bob-team': raw(10) });
    t('one');
    await dispatch(['sched']);
    expect(plain()).toMatch(/one .*fits on bob-team/);
  });

  test('when no seat has room the queue is held, with each seat named', async () => {
    const { db, t } = setup();
    process.env.SALU_FAKE_SEAT_USAGE = JSON.stringify({ 'alice-team': raw(80), 'bob-team': raw(75) });
    const x = t('big');
    await dispatch(['sched']);
    logs = [];
    const orch = new Orchestrator({ db, concurrency: 1, exitWhenEmpty: true, heartbeatMs: 100, runner: fakeRunner });
    const started = orch.start();
    await Bun.sleep(400);
    expect(getTicketById(db, x.id)!.status).toBe('todo');
    const last = readLast(db)!;
    expect(last.hold?.reason).toMatch(/big fits no seat \(alice-team: .*; bob-team: /);
    process.env.SALU_FAKE_SEAT_USAGE = JSON.stringify({ 'alice-team': raw(10), 'bob-team': raw(75) });
    await dispatch(['sched']);
    orch.stop?.();
    void started;
  });

  test('a dead seat, a seat with no login and a switched-off seat never take a ticket', async () => {
    const { db, p, t } = setup();
    addSeat(db, p.id, 'carol-team');
    addSeat(db, p.id, 'dave-team');
    setSeatDisabled(db, p.id, 'dave-team', true);
    process.env.SALU_FAKE_SEAT_USAGE = JSON.stringify({ 'alice-team': 'dead', 'bob-team': 'no-login', 'carol-team': raw(60), 'dave-team': raw(0) });
    const x = t('one');
    await dispatch(['sched']);
    await run(db);
    expect(getTicketById(db, x.id)!.seat_id).toBe(listSeats(db, p.id).find((s) => s.label === 'carol-team')!.id);
    expect(readLast(db)!.placed!.others.map((o) => o.seat).sort()).toEqual(['alice-team', 'bob-team', 'dave-team']);
  });

  test('a ticket that already has a seat stays on it, even when another has more room', async () => {
    const { db, a, t } = setup();
    process.env.SALU_FAKE_SEAT_USAGE = JSON.stringify({ 'alice-team': raw(30), 'bob-team': raw(0) });
    const x = t('resume');
    setTicketSeat(db, x.id, a.id);
    await dispatch(['sched']);
    await run(db);
    expect(getTicketById(db, x.id)!.seat_id).toBe(a.id);
  });

  test('two tickets in one minute do not both pile onto the seat that looked emptiest', async () => {
    const { db, b, t } = setup();
    process.env.SALU_FAKE_SEAT_USAGE = JSON.stringify({ 'alice-team': raw(50), 'bob-team': raw(30) });
    const one = t('one');
    const two = t('two');
    await dispatch(['sched']);
    await new Orchestrator({ db, concurrency: 2, exitWhenEmpty: true, heartbeatMs: 100, runner: fakeRunner }).start();
    const seats = [getTicketById(db, one.id)!.seat_id, getTicketById(db, two.id)!.seat_id];
    expect(seats).toContain(b.id);
    expect(new Set(seats).size).toBe(2);
  });

  test('a project without seats is scheduled on the machine meter as before', async () => {
    const db = openDb();
    const p = createProject(db, { name: 'solo', path: join(home, 'web') });
    setSchedMode(db, 'on');
    const x = createTicket(db, { status: 'todo', project_id: p.id, name: 'a', query: 'FAKE:done' });
    await run(db);
    expect(getTicketById(db, x.id)!.status).toBe('done');
    expect(getTicketById(db, x.id)!.seat_id ?? null).toBeNull();
  });
});
