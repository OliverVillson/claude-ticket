import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeDb, openDb } from '../src/db/db.ts';
import { createProject, createTicket, getTicketById, updateTicket, listTurns, replyToTicket, resolveTicketById } from '../src/db/queries.ts';
import { dispatch } from '../src/cli/dispatch.ts';
import { matchesFilter, parseFilter } from '../src/tui/filter.ts';
import { parseStatus, statusLabel } from '../src/core/format.ts';
import type { Project } from '../src/db/types.ts';

let home: string;
let db: ReturnType<typeof openDb>;
let project: Project;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ['SALU_HOME', 'SALU_WORKER']) saved[k] = process.env[k];
  home = mkdtempSync(join(tmpdir(), 'salu-resolved-'));
  mkdirSync(join(home, 'proj'));
  process.env.SALU_HOME = home;
  process.env.SALU_WORKER = 'fake';
  db = openDb();
  project = createProject(db, { name: 'demo', path: join(home, 'proj') });
});

afterEach(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const mk = (status: 'done' | 'blocked' | 'running' | 'failed') => {
  const t = createTicket(db, { project_id: project.id, name: 'x', query: 'q' });
  return updateTicket(db, t.id, { status });
};

const cli = async (...a: string[]) => {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...x: unknown[]) => void lines.push(x.join(' '));
  try {
    return { code: await dispatch(a), out: lines.join('\n') };
  } finally {
    console.log = log;
  }
};

describe('resolved tickets', () => {
  test('a finished ticket is called resolved, and `resolved` is accepted wherever a status is', () => {
    expect(statusLabel('done')).toBe('resolved');
    expect(statusLabel('blocked')).toBe('blocked');
    expect(parseStatus(' Resolved ')).toBe('done');
    const t = mk('done');
    const view = { ...t, project: 'demo', project_path: project.path };
    expect(matchesFilter(view, parseFilter('status:resolved'))).toBe(true);
    expect(matchesFilter(view, parseFilter('resolved'))).toBe(true);
    expect(matchesFilter(view, parseFilter('-resolved'))).toBe(false);
    expect(matchesFilter(view, parseFilter('status:done'))).toBe(true);
  });

  test('resolving keeps the session and conversation, and a reply revives it', () => {
    const t = mk('blocked');
    updateTicket(db, t.id, { session_id: 's1', error: 'need a key' });
    const r = resolveTicketById(db, t.id);
    expect(r.status).toBe('done');
    expect(r.error).toBeNull();
    expect(r.session_id).toBe('s1');
    expect(r.finished_at).not.toBeNull();
    const q = replyToTicket(db, t.id, 'one more thing');
    expect(q.status).toBe('todo');
    expect(getTicketById(db, t.id)!.session_id).toBe('s1');
    expect(listTurns(db, t.id).map((x) => x.body)).toEqual(['one more thing']);
  });

  test('a running ticket cannot be resolved', () => {
    const t = mk('running');
    expect(() => resolveTicketById(db, t.id)).toThrow(/running/);
  });

  test('salu resolve and salu reopen', async () => {
    const f = mk('failed');
    updateTicket(db, f.id, { session_id: 's1' });
    const a = await cli('resolve', 'x');
    expect(a.code).toBe(0);
    expect(a.out).toContain('resolved');
    expect(getTicketById(db, 1)!.status).toBe('done');
    expect((await cli('list', '--plain', '--status', 'resolved')).out).toContain('resolved');
    const b = await cli('reopen', 'x', 'please', 'continue');
    expect(b.code).toBe(0);
    expect(getTicketById(db, 1)!.status).toBe('todo');
    expect(listTurns(db, 1)[0]!.body).toBe('please continue');
    await cli('resolve', 'x');
    await cli('reopen', 'x');
    expect(getTicketById(db, 1)!.status).toBe('todo');
  });
});
