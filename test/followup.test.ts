import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeDb, openDb } from '../src/db/db.ts';
import { createProject, createTicket, getTicketById, listRuns, listTurns, pendingFollowUps, replyToTicket } from '../src/db/queries.ts';
import { Orchestrator } from '../src/orchestrator/scheduler.ts';
import { fakeRunner } from '../src/orchestrator/fake.ts';
import { buildFollowUpFreshPrompt, buildFollowUpPrompt } from '../src/orchestrator/prompt.ts';
import { promptFor, replyText } from '../src/orchestrator/worker.ts';
import { dispatch } from '../src/cli/dispatch.ts';
import type { Project } from '../src/db/types.ts';

let home: string;
let db: ReturnType<typeof openDb>;
let project: Project;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ['SALU_HOME', 'SALU_WORKER']) saved[k] = process.env[k];
  home = mkdtempSync(join(tmpdir(), 'salu-followup-'));
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

const run = async () => {
  const orch = new Orchestrator({ db, concurrency: 1, exitWhenEmpty: true, heartbeatMs: 100, runner: fakeRunner });
  await orch.start();
};
const mk = (name: string, query: string) => createTicket(db, { status: 'todo', project_id: project.id, name, query });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('follow-ups on a ticket', () => {
  test('the reply is kept, a follow-up resumes the same session and ends with a second reply', async () => {
    const t = mk('chat', 'FAKE:done first answer');
    await run();
    expect(listTurns(db, t.id).map((x) => [x.role, x.body])).toEqual([['assistant', 'first answer']]);
    const session = getTicketById(db, t.id)!.session_id;
    expect(session).toMatch(/^fake-/);

    const q = replyToTicket(db, t.id, 'now do the second thing');
    expect(q.status).toBe('todo');
    expect(pendingFollowUps(db, t.id)).toHaveLength(1);
    await run();

    const after = getTicketById(db, t.id)!;
    expect(after.status).toBe('done');
    expect(after.session_id).toBe(session);
    expect(listRuns(db, t.id)).toHaveLength(2);
    expect(pendingFollowUps(db, t.id)).toHaveLength(0);
    expect(listTurns(db, t.id).map((x) => [x.role, x.body])).toEqual([
      ['assistant', 'first answer'],
      ['user', 'now do the second thing'],
      ['assistant', 'Follow-up done: now do the second thing'],
    ]);
  });

  test('answering a blocked ticket runs it again', async () => {
    const t = mk('ask', 'FAKE:blocked which database?');
    await run();
    expect(getTicketById(db, t.id)!.status).toBe('blocked');
    replyToTicket(db, t.id, 'FAKE:done used postgres');
    await run();
    expect(getTicketById(db, t.id)!.status).toBe('done');
    expect(listTurns(db, t.id).at(-1)!.body).toBe('used postgres');
  });

  test('a message sent while the ticket runs becomes the next turn', async () => {
    const t = mk('busy', 'FAKE:sleep 300 then FAKE:done one');
    const orch = new Orchestrator({ db, concurrency: 1, exitWhenEmpty: true, heartbeatMs: 100, runner: fakeRunner });
    const p = orch.start();
    while (getTicketById(db, t.id)!.status !== 'running') await sleep(10);
    const r = replyToTicket(db, t.id, 'FAKE:done two');
    expect(r.status).toBe('running');
    await p;
    const after = getTicketById(db, t.id)!;
    expect(after.status).toBe('done');
    expect(listTurns(db, t.id).map((x) => x.body)).toEqual(['FAKE:done two', 'one', 'two']) // chronological: the message arrived while the first run was still going;
    expect(listRuns(db, t.id)).toHaveLength(2);
  });

  test('refuses a backlog ticket and an empty message', () => {
    const t = createTicket(db, { project_id: project.id, name: 'saved', query: 'x' });
    expect(() => replyToTicket(db, t.id, 'hi')).toThrow(/not run yet/);
    const d = mk('q', 'FAKE:done');
    expect(() => replyToTicket(db, d.id, '  ')).toThrow(/empty/);
  });

  test('deleting the ticket deletes its conversation', async () => {
    const t = mk('gone', 'FAKE:done');
    await run();
    db.run('DELETE FROM tickets WHERE id = ?', [t.id]);
    expect(listTurns(db, t.id)).toHaveLength(0);
  });
});

describe('prompts', () => {
  const view = (): any => ({ id: 3, name: 'n', project: 'p', query: 'first', labels: '[]' });
  test('resume with a follow-up carries the messages, not the interrupted-run text', () => {
    const p = promptFor({ ticket: view(), project: null, resume: 'sess', followUp: ['a', 'b'], abort: new AbortController() });
    expect(p).toContain('these messages');
    expect(p).toContain('a');
    expect(p).not.toContain('interrupted');
    expect(buildFollowUpPrompt(view(), ['only'])).toContain('The human wrote');
  });
  test('with no session the fresh prompt includes the conversation so far', () => {
    const p = buildFollowUpFreshPrompt(view(), [{ role: 'assistant', body: 'done it' }], ['more']);
    expect(p).toContain('first');
    expect(p).toContain('You: done it');
    expect(p.trim().endsWith('more')).toBe(true);
  });
  test('replyText drops the trailer', () => {
    expect(replyText('Did it.\n\nTICKET: done')).toBe('Did it.');
    expect(replyText('no trailer here')).toBe('no trailer here');
  });
});

describe('salu reply', () => {
  test('sends a message, then prints the conversation', async () => {
    const t = mk('cli', 'FAKE:done hello');
    await run();
    const out: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => void out.push(a.join(' '));
    try {
      expect(await dispatch(['reply', 'cli', 'and', 'more'])).toBe(0);
      expect(await dispatch(['reply', 'cli'])).toBe(0);
    } finally {
      console.log = log;
    }
    const text = out.join('\n');
    expect(text).toContain('sent to');
    expect(text).toContain('and more');
    expect(text).toContain('waiting for the worker');
    expect(getTicketById(db, t.id)!.status).toBe('todo');
  });
});
