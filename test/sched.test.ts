import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeDb, openDb } from '../src/db/db.ts';
import { claimNextTicket, createProject, createTicket, getState, getTicketById, listTickets, updateProject } from '../src/db/queries.ts';
import { ticketTags, type Project, type TicketView } from '../src/db/types.ts';
import { Orchestrator } from '../src/orchestrator/scheduler.ts';
import { fakeRunner } from '../src/orchestrator/fake.ts';
import type { OrchestratorEvent } from '../src/orchestrator/types.ts';
import { decide, fits, MAX_SKIPS, noteStarted, plan, routeFor, routeQueued, SESSION_MARGIN, WEEKLY_RESERVE } from '../src/sched/policy.ts';
import { estimateTicket, percentPerUsd, readStats, recordRunStats, schedMode, setSchedMode, SCHED_STATE, LEARNED_AFTER } from '../src/sched/stats.ts';
import { forecast, formatForecast } from '../src/sched/forecast.ts';
import { getUsageSnapshot, resetUsageCache, type UsageSnapshot, type UsageWindow } from '../src/usage/snapshot.ts';
import { dispatch } from '../src/cli/dispatch.ts';

let home: string;
let db: ReturnType<typeof openDb>;
let project: Project;
const saved: Record<string, string | undefined> = {};
const KEYS = ['SALU_SCHED_MARGIN', 'SALU_SCHED_RESERVE', 'SALU_HOME', 'SALU_WORKER', 'SALU_SCHED', 'SALU_FAKE_USAGE', 'SALU_BUDGET_USD_PER_DAY'];

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  home = mkdtempSync(join(tmpdir(), 'salu-sched-'));
  mkdirSync(join(home, 'proj'));
  process.env.SALU_HOME = home;
  process.env.SALU_WORKER = 'fake';
  delete process.env.SALU_SCHED;
  delete process.env.SALU_FAKE_USAGE;
  delete process.env.SALU_BUDGET_USD_PER_DAY;
  db = openDb();
  project = createProject(db, { name: 'demo', path: join(home, 'proj') });
});
afterEach(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const ticket = (name: string, o: { tags?: Record<string, string>; labels?: string[]; priority?: number; query?: string } = {}): TicketView =>
  createTicket(db, { status: 'todo', project_id: project.id, name, query: o.query ?? 'do the thing', tags: o.tags, labels: o.labels, priority: o.priority });

const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);
const win = (id: UsageWindow['id'], used: number | null, resetsInMs = 3_600_000, status: UsageWindow['status'] = 'allowed'): UsageWindow => ({
  id,
  short: id,
  label: id,
  percentUsed: used,
  percentLeft: used == null ? null : 100 - used,
  utilization: used == null ? null : used / 100,
  status,
  resetsAt: NOW + resetsInMs,
  observedAt: NOW,
  source: 'usage',
});
const snap = (...windows: UsageWindow[]): UsageSnapshot => ({ available: windows.length > 0, reason: null, reasonKind: null, plan: 'max', windows, updatedAt: NOW, fetchedAt: NOW, stale: false, error: null });

/** Teach the estimator that Opus/medium costs $2 and 4% of a window per run (so 2% per dollar). */
function learnOpus() {
  for (let i = 0; i < LEARNED_AFTER; i++) recordRunStats(db, 'claude-opus-5-5', 'medium', { usd: 2, pct: 4, at: NOW });
}

describe('estimates', () => {
  test('a guess until enough runs, then the median; percent only once the ratio is learned', () => {
    let e = estimateTicket(db, 'claude-opus-5-5', 'medium');
    expect(e).toMatchObject({ usd: 1.5, pct: null, samples: 0, learned: false });
    expect(estimateTicket(db, 'sonnet', 'high').usd).toBeCloseTo(0.6 * 1.6);
    learnOpus();
    e = estimateTicket(db, 'claude-opus-5-5', 'medium');
    expect(e.learned).toBe(true);
    expect(e.usd).toBe(2);
    expect(percentPerUsd(db)).toBe(2);
    expect(e.pct).toBe(4);
  });
  test('runs that cost nothing teach nothing; only the last 20 samples are kept', () => {
    recordRunStats(db, 'opus', 'medium', { usd: 0, pct: null, at: NOW });
    expect(readStats(db)).toEqual({});
    for (let i = 0; i < 30; i++) recordRunStats(db, 'opus', 'medium', { usd: 1, pct: null, at: NOW });
    expect(readStats(db)['opus|medium']).toHaveLength(20);
  });
  test('a paused ticket costs half: its session is already paid for', () => {
    learnOpus();
    const t = ticket('resume');
    const p = plan(db, { ...t, session_id: 's1' });
    expect(p.est.pct).toBe(2);
  });
});

describe('fits and decide', () => {
  test('no meter, no estimate: everything fits', () => {
    const t = ticket('a');
    expect(fits(db, plan(db, t), snap(), NOW).ok).toBe(true);
    expect(fits(db, plan(db, t), snap(win('session', 50)), NOW).ok).toBe(true); // no percent learned yet, room left
  });
  test('no percent learned: a full window still holds, with the reset time', () => {
    const t = ticket('a');
    const f = fits(db, plan(db, t), snap(win('session', 100 - SESSION_MARGIN, 1_800_000)), NOW);
    expect(f).toMatchObject({ ok: false, until: NOW + 1_800_000 });
    expect(fits(db, plan(db, t), snap(win('session', 100 - SESSION_MARGIN - 1)), NOW).ok).toBe(true);
  });
  test('SALU_SCHED_MARGIN moves the line, and the decision names its seat', () => {
    const t = ticket('a');
    process.env.SALU_SCHED_MARGIN = '60';
    try {
      expect(fits(db, plan(db, t), snap(win('session', 45)), NOW).ok).toBe(false);
      expect(decide(db, [t], snap(win('session', 45)), NOW).seat).toBe('self');
    } finally {
      delete process.env.SALU_SCHED_MARGIN;
    }
    expect(fits(db, plan(db, t), snap(win('session', 45)), NOW).ok).toBe(true);
  });
  test('the 5-hour window: fits with the margin, waits otherwise, with the reset time', () => {
    learnOpus();
    const t = ticket('a'); // 4%
    expect(fits(db, plan(db, t), snap(win('session', 100 - SESSION_MARGIN - 4)), NOW).ok).toBe(true);
    const f = fits(db, plan(db, t), snap(win('session', 100 - SESSION_MARGIN - 3, 1_800_000)), NOW);
    expect(f).toMatchObject({ ok: false, until: NOW + 1_800_000 });
  });
  test('the weekly reserve holds back normal tickets but not priority 0', () => {
    learnOpus();
    const s = snap(win('session', 10), win('weekly', 100 - WEEKLY_RESERVE - 3, 86_400_000));
    expect(fits(db, plan(db, ticket('normal')), s, NOW).ok).toBe(false);
    expect(fits(db, plan(db, ticket('now', { priority: 0 })), s, NOW).ok).toBe(true);
  });
  test('a ticket bigger than a whole window is let through, waiting would never help', () => {
    for (let i = 0; i < LEARNED_AFTER; i++) recordRunStats(db, 'claude-opus-5-5', 'medium', { usd: 50, pct: 100, at: NOW });
    expect(fits(db, plan(db, ticket('huge')), snap(win('session', 50)), NOW).ok).toBe(true);
  });
  test('a small ticket goes ahead of one that does not fit; the big one is counted as passed over', () => {
    learnOpus();
    const big = ticket('big', { tags: { effort: 'max' }, priority: 1 }); // 2 * 3.2 = 6.4 usd -> 12.8%
    const small = ticket('small', { tags: { model: 'haiku', effort: 'low' }, priority: 3 }); // 0.09 usd -> 0.18%
    const s = snap(win('session', 90));
    const cands = listTickets(db, { status: ['todo'] }).sort((a, b) => a.priority - b.priority);
    const d = decide(db, cands, s, NOW);
    expect(d.pick?.id).toBe(small.id);
    expect(d.skipped.map((x) => x.id)).toEqual([big.id]);
    noteStarted(db, d, small.id);
    expect(JSON.parse(getState(db, SCHED_STATE.skips)!)).toEqual({ [String(big.id)]: 1 });
  });
  test(`after ${MAX_SKIPS} pass-overs the big ticket is waited for, nothing starts ahead of it`, () => {
    learnOpus();
    const big = ticket('big', { tags: { effort: 'max' }, priority: 1 });
    ticket('small', { tags: { model: 'haiku', effort: 'low' } });
    const s = snap(win('session', 90, 600_000));
    const cands = () => listTickets(db, { status: ['todo'] }).sort((a, b) => a.priority - b.priority);
    for (let i = 0; i < MAX_SKIPS; i++) noteStarted(db, decide(db, cands(), s, NOW), 999);
    const d = decide(db, cands(), s, NOW);
    expect(d.pick).toBeNull();
    expect(d.hold).toMatchObject({ until: NOW + 600_000 });
    expect(d.hold!.reason).toContain(big.name);
  });
  test('nothing fits: held until the earliest reset', () => {
    learnOpus();
    ticket('a');
    const d = decide(db, listTickets(db, { status: ['todo'] }), snap(win('session', 98, 900_000)), NOW);
    expect(d.pick).toBeNull();
    expect(d.hold!.until).toBe(NOW + 900_000);
  });
  test('without a plan meter the daily dollar budget counts', () => {
    process.env.SALU_BUDGET_USD_PER_DAY = '3';
    const t = ticket('a'); // guess $1.50
    expect(fits(db, plan(db, t), snap(), NOW).ok).toBe(true); // nothing spent yet
    db.run('INSERT INTO runs (ticket_id, started_at, cost_usd) VALUES (?, ?, ?)', [t.id, Date.now(), 2.5]);
    expect(fits(db, plan(db, t), snap(), Date.now())).toMatchObject({ ok: false });
  });
});

describe('model routing', () => {
  test('light labels go to Sonnet; heavy words, model tags, high effort, project defaults and route=off do not', () => {
    const s = snap();
    expect(routeFor(db, ticket('typo', { labels: ['typo'] }), s)).toMatchObject({ model: 'sonnet', why: 'light-task' });
    expect(routeFor(db, ticket('heavy', { labels: ['docs'], query: 'refactor the whole docs pipeline' }), s)).toBeNull();
    expect(routeFor(db, ticket('plain'), s)).toBeNull();
    expect(routeFor(db, ticket('named', { labels: ['docs'], tags: { model: 'opus' } }), s)).toBeNull();
    expect(routeFor(db, ticket('hard', { labels: ['docs'], tags: { effort: 'high' } }), s)).toBeNull();
    expect(routeFor(db, ticket('off', { labels: ['docs'], tags: { route: 'off' } }), s)).toBeNull();
    expect(routeFor(db, ticket('urgent', { labels: ['docs'], priority: 0 }), s)).toBeNull();
    updateProject(db, project.id, { default_model: 'opus' });
    expect(routeFor(db, ticket('pinned', { labels: ['docs'] }), s)).toBeNull();
  });
  test('when the Opus window is nearly used and Sonnet has room, new tickets go to Sonnet', () => {
    const t = ticket('any');
    expect(routeFor(db, t, snap(win('opus', 90), win('sonnet', 20)))).toMatchObject({ model: 'sonnet' });
    expect(routeFor(db, t, snap(win('opus', 60), win('sonnet', 20)))).toBeNull();
    expect(routeFor(db, t, snap(win('opus', 90), win('sonnet', 80)))).toBeNull();
    expect(routeFor(db, t, snap(win('opus', 100, 3_600_000, 'rejected')))).toMatchObject({ model: 'sonnet' });
  });
  test('advise reports, on writes the model and the reason onto the ticket', () => {
    const t = ticket('typo', { labels: ['typo'] });
    const advised = routeQueued(db, snap(), 'advise');
    expect(advised).toEqual([{ name: 'typo', model: 'sonnet', why: 'light-task', applied: false }]);
    expect(ticketTags(getTicketById(db, t.id)!).model).toBeUndefined();
    routeQueued(db, snap(), 'on');
    expect(ticketTags(getTicketById(db, t.id)!)).toMatchObject({ model: 'sonnet', routed: 'light-task' });
    expect(routeQueued(db, snap(), 'on')).toEqual([]); // already routed
  });
});

describe('claimNextTicket choose', () => {
  test('a chooser can take a later candidate or hold them all', () => {
    const a = ticket('a');
    const b = ticket('b');
    expect(claimNextTicket(db, { choose: () => null })).toBeNull();
    expect(getTicketById(db, a.id)!.status).toBe('todo');
    expect(claimNextTicket(db, { choose: (c) => c.find((x) => x.id === b.id) ?? null })!.id).toBe(b.id);
    expect(getTicketById(db, a.id)!.status).toBe('todo');
  });
});

describe('forecast and the command', () => {
  test('forecast lists the queue with fit and totals', () => {
    learnOpus();
    ticket('a');
    ticket('b', { tags: { model: 'haiku' } });
    const f = forecast(db, snap(win('session', 95)), NOW);
    expect(f.queued).toHaveLength(2);
    expect(f.totalUsd).toBeCloseTo(2 + 0.15);
    const text = formatForecast(f, snap(win('session', 95)), NOW).join('\n');
    expect(text).toContain('advise');
    expect(text).toContain('waits:');
  });
  test('salu sched sets the mode and prints without a meter', async () => {
    const out: string[] = [];
    const orig = console.log;
    console.log = (...a: any[]) => void out.push(a.join(' '));
    try {
      expect(schedMode(db)).toBe('advise');
      expect(await dispatch(['sched', 'on'])).toBe(0);
      expect(schedMode(db)).toBe('on');
      expect(await dispatch(['sched'])).toBe(0);
    } finally {
      console.log = orig;
    }
    expect(out.join('\n')).toContain('scheduler on');
  });
});

describe('the orchestrator', () => {
  function make() {
    const events: OrchestratorEvent[] = [];
    const orch = new Orchestrator({ db, concurrency: 2, exitWhenEmpty: true, heartbeatMs: 100, runner: fakeRunner, onEvent: (e) => events.push(e) });
    return { orch, events };
  }
  const feed = async (utilization: number, resetsInMs = 3_600_000) => {
    process.env.SALU_FAKE_USAGE = JSON.stringify({ subscription_type: 'max', rate_limits: { five_hour: { utilization, resets_at: new Date(Date.now() + resetsInMs).toISOString() } } });
    resetUsageCache(db);
    await getUsageSnapshot({ db, force: true });
  };

  test('advise mode changes nothing: tickets still run although the window is nearly full', async () => {
    learnOpus();
    await feed(99);
    const t = ticket('a', { query: 'FAKE:done' });
    const { orch } = make();
    await orch.start();
    expect(getTicketById(db, t.id)!.status).toBe('done');
    expect(JSON.parse(getState(db, SCHED_STATE.last)!).mode).toBe('advise');
  });

  test('on mode holds the queue until the window resets and says so', async () => {
    learnOpus();
    await feed(99, 600_000);
    setSchedMode(db, 'on');
    const t = ticket('a', { query: 'FAKE:done' });
    const { orch, events } = make();
    const run = orch.start();
    await new Promise((r) => setTimeout(r, 500));
    expect(getTicketById(db, t.id)!.status).toBe('todo');
    expect(events.some((e) => e.type === 'log' && /holding the queue until/.test(e.message))).toBe(true);
    expect(events.some((e) => e.type === 'dispatch')).toBe(false);
    orch.stop('test');
    await run;
  });

  test('on mode starts the ticket that fits and routes a light ticket to Sonnet', async () => {
    learnOpus();
    await feed(10);
    setSchedMode(db, 'on');
    const t = ticket('typo', { query: 'FAKE:done', labels: ['typo'] });
    const { orch } = make();
    await orch.start();
    const row = getTicketById(db, t.id)!;
    expect(row.status).toBe('done');
    expect(ticketTags(row)).toMatchObject({ model: 'sonnet', routed: 'light-task' });
  });

  test('finished runs teach the estimator, the dollar part at least', async () => {
    await feed(10);
    const t = ticket('a', { query: 'FAKE:done' });
    const { orch } = make();
    await orch.start();
    await new Promise((r) => setTimeout(r, 100));
    expect(getTicketById(db, t.id)!.status).toBe('done');
    expect(Object.keys(readStats(db))).toContain('opus|medium');
  });

  test('off mode never writes anything', async () => {
    setSchedMode(db, 'off');
    ticket('a', { query: 'FAKE:done' });
    const { orch } = make();
    await orch.start();
    expect(getState(db, SCHED_STATE.last)).toBeNull();
    expect(getState(db, SCHED_STATE.stats)).toBeNull();
  });
});
