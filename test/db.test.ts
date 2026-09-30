import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../src/db/db.ts';
import {
  claimNextTicket,
  countTickets,
  createProject,
  createRun,
  createTicket,
  deleteProject,
  deleteTicket,
  findProjectForCwd,
  finishRun,
  getDefaultProject,
  getState,
  getTicketById,
  latestRun,
  listTickets,
  setState,
  updateTicket,
} from '../src/db/queries.ts';
import { resolveProject, resolveTicket } from '../src/core/resolve.ts';
import { clearPause, readStatus, setPause, writeWorkerInfo } from '../src/orchestrator/status.ts';

let home: string;
let db: ReturnType<typeof openDb>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ticket-db-'));
  db = openDb(join(home, 't.db'));
});
afterEach(() => {
  db.close();
  rmSync(home, { recursive: true, force: true });
});

describe('projects', () => {
  test('first project becomes default; names unique', () => {
    const a = createProject(db, { name: 'a', path: '/tmp/a' });
    const b = createProject(db, { name: 'b', path: '/tmp/b' });
    expect(a.is_default).toBe(1);
    expect(b.is_default).toBe(0);
    expect(() => createProject(db, { name: 'a', path: '/tmp/a' })).toThrow(/already exists/);
    deleteProject(db, a.id);
    expect(getDefaultProject(db)?.name).toBe('b');
  });
  test('findProjectForCwd picks the longest containing path', () => {
    createProject(db, { name: 'root', path: '/tmp/w' });
    const sub = createProject(db, { name: 'sub', path: '/tmp/w/sub' });
    expect(findProjectForCwd(db, '/tmp/w/sub/src')?.id).toBe(sub.id);
    expect(findProjectForCwd(db, '/tmp/w/other')?.name).toBe('root');
    expect(findProjectForCwd(db, '/tmp/elsewhere')).toBeNull();
    expect(resolveProject(db, null, '/tmp/elsewhere').name).toBe('root'); // default
    expect(() => resolveProject(db, 'nope')).toThrow(/no project named/);
  });
});

describe('tickets', () => {
  test('create, list ordering, unique per project, delete', () => {
    const p = createProject(db, { name: 'p', path: '/tmp/p' });
    const q = createProject(db, { name: 'q', path: '/tmp/q' });
    const t1 = createTicket(db, { project_id: p.id, name: 'one', query: 'do one', priority: 3 });
    const t2 = createTicket(db, { project_id: p.id, name: 'two', query: 'do two', priority: 1 });
    const t3 = createTicket(db, { project_id: q.id, name: 'one', query: 'other project same name' });
    expect(() => createTicket(db, { project_id: p.id, name: 'one', query: 'dup' })).toThrow(/already exists/);
    expect(listTickets(db).map((t) => t.id)).toEqual([t2.id, t1.id, t3.id]);
    expect(listTickets(db, { projectId: q.id }).map((t) => t.id)).toEqual([t3.id]);
    expect(resolveTicket(db, 'two').id).toBe(t2.id);
    expect(resolveTicket(db, 'one', { cwd: '/nowhere' }).id).toBe(t1.id); // ambiguous name: default project wins
    expect(resolveTicket(db, 'one', { project: 'q' }).id).toBe(t3.id);
    expect(resolveTicket(db, 'one', { cwd: '/tmp/q/src' }).id).toBe(t3.id);
    deleteTicket(db, t1.id);
    expect(getTicketById(db, t1.id)).toBeNull();
    expect(countTickets(db).todo).toBe(2);
  });

  test('claimNextTicket: paused first, then priority, then age; skips excluded models', () => {
    const p = createProject(db, { name: 'p', path: '/tmp/p', defaultModel: 'opus' });
    const older = createTicket(db, { project_id: p.id, name: 'older', query: 'x', priority: 2 });
    const newer = createTicket(db, { project_id: p.id, name: 'newer', query: 'x', priority: 2 });
    updateTicket(db, newer.id, { created_at: older.created_at + 10 } as any);
    const top = createTicket(db, { project_id: p.id, name: 'top', query: 'x', priority: 1, tags: { model: 'sonnet' } });
    const paused = createTicket(db, { project_id: p.id, name: 'paused', query: 'x', priority: 5 });
    updateTicket(db, paused.id, { status: 'paused', session_id: 'sess-1' });

    // Opus is exhausted: only sonnet tickets are claimable (paused one inherits opus).
    const c1 = claimNextTicket(db, { excludeModels: ['opus'] })!;
    expect(c1.name).toBe('top');
    expect(c1.status).toBe('running');
    expect(c1.attempts).toBe(1);
    expect(claimNextTicket(db, { excludeModels: ['opus'] })).toBeNull();

    const c2 = claimNextTicket(db)!;
    expect(c2.name).toBe('paused');
    expect(c2.session_id).toBe('sess-1');
    expect(claimNextTicket(db)!.name).toBe('older');
    expect(claimNextTicket(db)!.name).toBe('newer');
    expect(claimNextTicket(db)).toBeNull();
    expect(claimNextTicket(db, { projectIds: [p.id + 99] })).toBeNull();
  });

  test('runs', () => {
    const p = createProject(db, { name: 'p', path: '/tmp/p' });
    const t = createTicket(db, { project_id: p.id, name: 't', query: 'x' });
    const r = createRun(db, t.id, '/tmp/log.jsonl');
    finishRun(db, r.id, { outcome: 'done', turns: 3, cost_usd: 0.05 });
    const l = latestRun(db, t.id)!;
    expect(l.outcome).toBe('done');
    expect(l.turns).toBe(3);
    expect(l.ended_at).not.toBeNull();
  });
});

describe('state and status', () => {
  test('key/value state', () => {
    setState(db, 'k', 'v');
    expect(getState(db, 'k')).toBe('v');
    setState(db, 'k', null);
    expect(getState(db, 'k')).toBeNull();
  });
  test('readStatus: not alive without heartbeat; pause info; workers only when alive', () => {
    expect(readStatus(db).alive).toBe(false);
    setPause(db, { until: Date.now() + 60_000, reason: 'limit', kind: 'session' });
    let s = readStatus(db);
    expect(s.paused?.kind).toBe('session');
    expect(s.paused?.manual).toBe(false);
    setPause(db, { until: null, reason: 'manual', kind: 'manual', manual: true });
    expect(readStatus(db).paused?.manual).toBe(true);
    clearPause(db);
    expect(readStatus(db).paused).toBeNull();
    // expired pause is not a pause
    setPause(db, { until: Date.now() - 1, reason: 'old', kind: 'session' });
    expect(readStatus(db).paused).toBeNull();

    writeWorkerInfo(db, { ticketId: 1, runId: 1, startedAt: Date.now(), turns: 2, lastTool: 'Bash', lastText: null, model: null, sessionId: null, updatedAt: Date.now() });
    expect(readStatus(db).workers.length).toBe(0); // orchestrator not alive
    setState(db, 'orchestrator_pid', process.pid);
    setState(db, 'orchestrator_heartbeat', Date.now());
    s = readStatus(db);
    expect(s.alive).toBe(true);
    expect(s.workers.length).toBe(1);
  });
});
