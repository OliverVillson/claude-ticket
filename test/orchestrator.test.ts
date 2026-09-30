import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeDb, openDb } from '../src/db/db.ts';
import { createProject, createTicket, deleteTicket, getState, getTicketById, listRuns, listTickets, updateProject, updateTicket } from '../src/db/queries.ts';
import { STATE, type Project, type TicketView } from '../src/db/types.ts';
import { Orchestrator } from '../src/orchestrator/scheduler.ts';
import { fakeRunner } from '../src/orchestrator/fake.ts';
import type { OrchestratorEvent } from '../src/orchestrator/types.ts';
import { clearPause, getPause } from '../src/usage/index.ts';
import { readStatus } from '../src/orchestrator/status.ts';

let home: string;
let projPath: string;
let db: ReturnType<typeof openDb>;
let project: Project;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ['SALU_HOME', 'SALU_WORKER', 'SALU_RESUME_MARGIN_MS', 'SALU_FAKE_LIMIT_UNTIL']) saved[k] = process.env[k];
  home = mkdtempSync(join(tmpdir(), 'ticket-orch-'));
  projPath = join(home, 'proj');
  mkdirSync(projPath);
  process.env.SALU_HOME = home;
  process.env.SALU_WORKER = 'fake';
  process.env.SALU_RESUME_MARGIN_MS = '0';
  delete process.env.SALU_FAKE_LIMIT_UNTIL;
  db = openDb();
  project = createProject(db, { name: 'demo', path: projPath });
});

afterEach(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function ticket(name: string, query: string, extra: { tags?: Record<string, string>; priority?: number; projectId?: number } = {}): TicketView {
  return createTicket(db, { project_id: extra.projectId ?? project.id, name, query, tags: extra.tags, priority: extra.priority });
}

function make(o: { concurrency?: number; projectIds?: number[]; exitWhenEmpty?: boolean } = {}) {
  const events: OrchestratorEvent[] = [];
  let live = 0;
  let maxLive = 0;
  const orch = new Orchestrator({
    db,
    concurrency: o.concurrency ?? 2,
    projectIds: o.projectIds,
    exitWhenEmpty: o.exitWhenEmpty ?? true,
    heartbeatMs: 100,
    runner: fakeRunner,
    onEvent: (e) => {
      events.push(e);
      if (e.type === 'dispatch') maxLive = Math.max(maxLive, ++live);
      if (e.type === 'finish') live--;
    },
  });
  return { orch, events, maxLive: () => maxLive };
}

const status = (id: number) => getTicketById(db, id)!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await sleep(20);
  }
}

describe('dispatch', () => {
  test('a queue of three tickets runs to completion with a cap of 2', async () => {
    const a = ticket('a', 'FAKE:sleep 200 then FAKE:done first');
    const b = ticket('b', 'FAKE:sleep 200 then FAKE:done second');
    const c = ticket('c', 'FAKE:sleep 200 then FAKE:done third');
    const { orch, events, maxLive } = make({ concurrency: 2 });
    await orch.start();
    for (const t of [a, b, c]) {
      const row = status(t.id);
      expect(row.status).toBe('done');
      expect(row.session_id).toMatch(/^fake-/);
      expect(row.cost_usd).toBeGreaterThan(0);
      const runs = listRuns(db, t.id);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.outcome).toBe('done');
      expect(runs[0]!.turns).toBeGreaterThan(0);
      expect(existsSync(runs[0]!.log_path!)).toBe(true);
      const lines = readFileSync(runs[0]!.log_path!, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect(lines.some((l) => l.type === 'result')).toBe(true);
    }
    expect(maxLive()).toBe(2);
    expect(events.filter((e) => e.type === 'finish')).toHaveLength(3);
    expect(events.at(-1)!.type).toBe('stop');
    // The orchestrator cleaned up after itself.
    expect(getState(db, STATE.pid)).toBeNull();
    expect(readStatus(db).alive).toBe(false);
  });

  test('dispatches by priority, then age', async () => {
    const low = ticket('low', 'FAKE:done', { priority: 5 });
    const high = ticket('high', 'FAKE:done', { priority: 1 });
    const mid = ticket('mid', 'FAKE:done', { priority: 3 });
    const { orch, events } = make({ concurrency: 1 });
    await orch.start();
    const order = events.filter((e): e is Extract<OrchestratorEvent, { type: 'dispatch' }> => e.type === 'dispatch').map((e) => e.ticket.id);
    expect(order).toEqual([high.id, mid.id, low.id]);
  });

  test('priority 0 (run now) jumps the queue', async () => {
    ticket('normal', 'FAKE:done', { priority: 1 });
    const now = ticket('now', 'FAKE:done', { priority: 3 });
    updateTicket(db, now.id, { priority: 0 });
    const { orch, events } = make({ concurrency: 1 });
    await orch.start();
    const first = events.find((e) => e.type === 'dispatch') as Extract<OrchestratorEvent, { type: 'dispatch' }>;
    expect(first.ticket.id).toBe(now.id);
  });

  test("a project's own concurrency caps its running tickets", async () => {
    updateProject(db, project.id, { concurrency: 1 });
    ticket('a', 'FAKE:sleep 100 then FAKE:done');
    ticket('b', 'FAKE:sleep 100 then FAKE:done');
    ticket('c', 'FAKE:sleep 100 then FAKE:done');
    const { orch, maxLive } = make({ concurrency: 3 });
    await orch.start();
    expect(maxLive()).toBe(1);
    expect(listTickets(db, { status: 'done' })).toHaveLength(3);
  });

  test('only the named projects are dispatched', async () => {
    const other = createProject(db, { name: 'other', path: projPath });
    const mine = ticket('mine', 'FAKE:done');
    const theirs = ticket('theirs', 'FAKE:done', { projectId: other.id });
    const { orch } = make({ projectIds: [project.id] });
    await orch.start();
    expect(status(mine.id).status).toBe('done');
    expect(status(theirs.id).status).toBe('todo');
  });
});

describe('environment problems', () => {
  test('Claude Code missing: the ticket goes back to todo untouched, nothing else is tried, the run ends with the reason', async () => {
    const a = ticket('a', 'x');
    const b = ticket('b', 'x');
    const events: OrchestratorEvent[] = [];
    const broken = {
      name: 'broken',
      async *run(): AsyncGenerator<any> {
        throw new Error('Native CLI binary for darwin-arm64 not found. Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional, or set options.pathToClaudeCodeExecutable.');
      },
      async probe() {
        return 'ok' as const;
      },
    };
    const orch = new Orchestrator({ db, concurrency: 1, exitWhenEmpty: true, heartbeatMs: 100, runner: broken as any, onEvent: (e) => events.push(e) });
    await orch.start();
    const first = [status(a.id), status(b.id)];
    expect(first.map((t) => t.status)).toEqual(['todo', 'todo']);
    expect(first.every((t) => t.attempts === 0 || t.attempts === undefined || t.attempts < 1)).toBe(true);
    expect(first.some((t) => (t.error ?? '').includes('claude.ai/install.sh'))).toBe(true);
    expect(listRuns(db, a.id).length + listRuns(db, b.id).length).toBe(1); // only one ticket was even tried
    expect(events.some((e) => e.type === 'log' && e.level === 'error' && e.message.includes('salu run'))).toBe(true);
  });
});

describe('outcomes', () => {
  test('a failing ticket is retried once, then marked failed', async () => {
    const t = ticket('flaky', 'FAKE:failed cannot reach the database');
    const { orch, events } = make();
    await orch.start();
    const row = status(t.id);
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(2);
    expect(row.error).toBe('cannot reach the database');
    expect(listRuns(db, t.id).map((r) => r.outcome)).toEqual(['failed', 'failed']);
    const finishes = events.filter((e) => e.type === 'finish') as Extract<OrchestratorEvent, { type: 'finish' }>[];
    expect(finishes.map((f) => f.status)).toEqual(['todo', 'failed']);
  });

  test('running out of turns counts as a failure and keeps the session for the retry', async () => {
    const t = ticket('long', 'FAKE:max-turns');
    const { orch, events } = make();
    await orch.start();
    expect(status(t.id).status).toBe('failed');
    const dispatches = events.filter((e) => e.type === 'dispatch') as Extract<OrchestratorEvent, { type: 'dispatch' }>[];
    expect(dispatches.map((d) => d.resumed)).toEqual([false, true]);
  });

  test('a crash in the worker is a failure, not a crash of the orchestrator', async () => {
    const t = ticket('boom', 'FAKE:crash');
    const { orch } = make();
    await orch.start();
    const row = status(t.id);
    expect(row.status).toBe('failed');
    expect(row.error).toContain('fake worker crashed');
  });

  test('a blocked ticket stores the question and is not retried', async () => {
    const t = ticket('ask', 'FAKE:blocked which database should I use?');
    const { orch } = make();
    await orch.start();
    const row = status(t.id);
    expect(row.status).toBe('blocked');
    expect(row.error).toBe('which database should I use?');
    expect(row.attempts).toBe(1);
  });
});

describe('usage limits', () => {
  test('a session limit pauses the ticket with its session, then the probe resumes it in the same session', async () => {
    const t = ticket('limited', 'FAKE:ratelimit session resets +600');
    const { orch, events } = make({ concurrency: 1 });
    // Once the limit is recorded, make the ticket finish on its next run.
    orch.on((e) => {
      if (e.type === 'pause') updateTicket(db, t.id, { query: 'FAKE:done after the reset' });
    });
    await orch.start();
    const row = status(t.id);
    expect(row.status).toBe('done');
    const types = events.map((e) => e.type);
    expect(types).toContain('pause');
    expect(types).toContain('probe');
    expect(types).toContain('resume');
    const dispatches = events.filter((e) => e.type === 'dispatch') as Extract<OrchestratorEvent, { type: 'dispatch' }>[];
    expect(dispatches.map((d) => d.resumed)).toEqual([false, true]);
    const runs = listRuns(db, t.id).reverse();
    expect(runs.map((r) => r.outcome)).toEqual(['rate_limited', 'done']);
    // The limit did not count as an attempt against the ticket.
    expect(row.attempts).toBe(1);
    const firstLog = readFileSync(runs[0]!.log_path!, 'utf8');
    const sid = JSON.parse(firstLog.split('\n').find((l) => l.includes('"subtype":"init"'))!).session_id;
    expect(row.session_id).toBe(sid);
    expect(getPause(db)).toBeNull();
    expect(dispatches[0]!.ticket.id).toBe(t.id);
  });

  test('a limit reported as text only ("hit your session limit · resets ...") also pauses', async () => {
    const t = ticket('textlimit', 'FAKE:ratelimit session resets 11:59pm');
    const { orch, events } = make({ concurrency: 1, exitWhenEmpty: false });
    const run = orch.start();
    await until(() => events.some((e) => e.type === 'pause'));
    expect(status(t.id).status).toBe('paused');
    const pause = getPause(db)!;
    expect(pause.kind).toBe('session');
    expect(pause.until).toBeGreaterThan(Date.now());
    orch.stop('test');
    await run;
  });

  test('an Opus limit keeps Sonnet tickets running and holds Opus ones until the reset', async () => {
    const opus1 = ticket('opus-1', 'FAKE:ratelimit opus resets +700', { tags: { model: 'opus' }, priority: 1 });
    const sonnetLong = ticket('sonnet-long', 'FAKE:sleep 400 then FAKE:done', { tags: { model: 'sonnet' }, priority: 2 });
    const opus2 = ticket('opus-2', 'FAKE:done', { tags: { model: 'opus' }, priority: 3 });
    const sonnet2 = ticket('sonnet-2', 'FAKE:done', { tags: { model: 'sonnet' }, priority: 4 });
    const { orch, events } = make({ concurrency: 2 });
    orch.on((e) => {
      if (e.type === 'pause') updateTicket(db, opus1.id, { query: 'FAKE:done' });
    });
    await orch.start();
    for (const t of [opus1, sonnetLong, opus2, sonnet2]) expect(status(t.id).status).toBe('done');
    const idx = (pred: (e: OrchestratorEvent) => boolean) => events.findIndex(pred);
    const dispatchOf = (id: number) => idx((e) => e.type === 'dispatch' && e.ticket.id === id);
    const pauseAt = idx((e) => e.type === 'pause');
    const resumeAt = idx((e) => e.type === 'resume');
    expect(pauseAt).toBeGreaterThan(-1);
    expect(resumeAt).toBeGreaterThan(pauseAt);
    // sonnet-2 was dispatched while the Opus pause was on; opus-2 only after it lifted.
    expect(dispatchOf(sonnet2.id)).toBeGreaterThan(pauseAt);
    expect(dispatchOf(sonnet2.id)).toBeLessThan(resumeAt);
    expect(dispatchOf(opus2.id)).toBeGreaterThan(resumeAt);
    const pause = events[pauseAt] as Extract<OrchestratorEvent, { type: 'pause' }>;
    expect(pause.models.length).toBeGreaterThan(0);
  });

  test('the probe finding the window still closed pushes the resume out', async () => {
    const t = ticket('slow-window', 'FAKE:ratelimit session resets +300');
    process.env.SALU_FAKE_LIMIT_UNTIL = String(Date.now() + 1300);
    const { orch, events } = make({ concurrency: 1 });
    orch.on((e) => {
      if (e.type === 'pause') updateTicket(db, t.id, { query: 'FAKE:done' });
    });
    await orch.start();
    expect(status(t.id).status).toBe('done');
    const probes = events.filter((e) => e.type === 'probe') as Extract<OrchestratorEvent, { type: 'probe' }>[];
    expect(probes.some((p) => !p.ok)).toBe(true);
    expect(probes.at(-1)!.ok).toBe(true);
  });
});

describe('control', () => {
  test('a manual pause holds dispatch and resume releases it', async () => {
    const t = ticket('held', 'FAKE:done');
    orchPause();
    const { orch, events } = make({ exitWhenEmpty: false });
    const run = orch.start();
    await sleep(400);
    expect(status(t.id).status).toBe('todo');
    expect(events.some((e) => e.type === 'dispatch')).toBe(false);
    expect(events.some((e) => e.type === 'pause')).toBe(true);
    orch.resume();
    await until(() => status(t.id).status === 'done');
    expect(events.some((e) => e.type === 'resume')).toBe(true);
    orch.stop('test');
    await run;

    function orchPause() {
      db.run("INSERT INTO state (key, value) VALUES ('manual_pause', '1') ON CONFLICT(key) DO UPDATE SET value = '1'");
    }
  });

  test('stop() interrupts running workers and puts their tickets back with the session kept', async () => {
    const t = ticket('interrupted', 'FAKE:sleep 10000 then FAKE:done');
    const { orch, events } = make({ concurrency: 1, exitWhenEmpty: false });
    const run = orch.start();
    await until(() => events.some((e) => e.type === 'worker'));
    orch.stop('SIGTERM');
    await run;
    const row = status(t.id);
    expect(row.status).toBe('todo');
    expect(row.session_id).toMatch(/^fake-/);
    expect(row.attempts).toBe(0);
    expect(listRuns(db, t.id)[0]!.outcome).toBe('killed');
    expect(readStatus(db).alive).toBe(false);
    expect(getState(db, 'worker:' + t.id)).toBeNull();
  });

  test('removing a running salu stops its worker', async () => {
    const t = ticket('doomed', 'FAKE:sleep 10000 then FAKE:done');
    const { orch, events } = make({ concurrency: 1, exitWhenEmpty: false });
    const run = orch.start();
    await until(() => events.some((e) => e.type === 'worker'));
    deleteTicket(db, t.id);
    await until(() => events.some((e) => e.type === 'finish'));
    const fin = events.find((e) => e.type === 'finish') as Extract<OrchestratorEvent, { type: 'finish' }>;
    expect(fin.outcome).toBe('killed');
    orch.stop('test');
    await run;
    expect(getTicketById(db, t.id)).toBeNull();
  });

  test('changing a running ticket back to todo stops its worker', async () => {
    const t = ticket('rewound', 'FAKE:sleep 10000 then FAKE:done');
    const { orch, events } = make({ concurrency: 1, exitWhenEmpty: false });
    const run = orch.start();
    await until(() => events.some((e) => e.type === 'worker'));
    updateTicket(db, t.id, { status: 'todo', query: 'FAKE:done' });
    await until(() => status(t.id).status === 'done', 8000);
    orch.stop('test');
    await run;
  });

  test('a second orchestrator refuses to start while one is alive', async () => {
    ticket('x', 'FAKE:sleep 500 then FAKE:done');
    const a = make({ exitWhenEmpty: false });
    const run = a.orch.start();
    await until(() => readStatus(db).alive);
    // Simulate another process: same db, different pid.
    db.run("UPDATE state SET value = ? WHERE key = 'orchestrator_pid'", [String(process.ppid)]);
    const b = make();
    await expect(b.orch.start()).rejects.toThrow(/already running/);
    a.orch.stop('test');
    await run;
  });

  test('tickets a dead orchestrator left running go back to the queue on start', async () => {
    const t = ticket('orphan', 'FAKE:done');
    updateTicket(db, t.id, { status: 'running', session_id: 'fake-old-session' });
    const { orch, events } = make();
    await orch.start();
    expect(status(t.id).status).toBe('done');
    const d = events.find((e) => e.type === 'dispatch') as Extract<OrchestratorEvent, { type: 'dispatch' }>;
    expect(d.resumed).toBe(true);
  });

  test('a ticket added while the orchestrator idles is picked up straight away', async () => {
    const { orch, events } = make({ exitWhenEmpty: false });
    const run = orch.start();
    await until(() => events.some((e) => e.type === 'idle'));
    const t = ticket('late', 'FAKE:done'); // createTicket touches the wake file
    const t0 = Date.now();
    await until(() => status(t.id).status === 'done');
    expect(Date.now() - t0).toBeLessThan(1500);
    orch.stop('test');
    await run;
  });
});
