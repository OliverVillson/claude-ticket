import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeDb, openDb } from '../src/db/db.ts';
import { createProject, createTicket, getTicketById, listTickets, listTurns, replyToTicket } from '../src/db/queries.ts';
import { Orchestrator } from '../src/orchestrator/scheduler.ts';
import { fakeRunner } from '../src/orchestrator/fake.ts';
import { saluToolOn, workerSdkOptions } from '../src/orchestrator/worker.ts';
import { dispatch } from '../src/cli/dispatch.ts';
import { answerAndNotify } from '../src/threads/decide.ts';
import { MAX_CHILDREN, TOOL_NAMES, TOOLS, callTool, saluMcpServer } from '../src/threads/tool.ts';
import { getChecklist, listChildren, listDecisions, listOutputs, threadSummary } from '../src/threads/store.ts';
import type { Project } from '../src/db/types.ts';

let home: string;
let db: ReturnType<typeof openDb>;
let project: Project;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ['SALU_HOME', 'SALU_WORKER']) saved[k] = process.env[k];
  home = mkdtempSync(join(tmpdir(), 'salu-threads-'));
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

const mk = (name: string, query: string, tags: Record<string, string> = {}) => createTicket(db, { status: 'todo', project_id: project.id, name, query, tags });
const run = async () => {
  const orch = new Orchestrator({ db, concurrency: 1, exitWhenEmpty: true, heartbeatMs: 100, runner: fakeRunner });
  await orch.start();
};
const ctx = (id: number) => ({ db, ticket: getTicketById(db, id)! });
const script = (calls: unknown[], then: string) => `FAKE:tools ${JSON.stringify(calls)} then ${then}`;

describe('schema', () => {
  test('is v10 with the thread tables', () => {
    expect(db.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version).toBe(10);
    const t = mk('a', 'FAKE:done');
    expect(threadSummary(db, t.id)).toEqual({ checklist: [], decisions: [], outputs: [], parent: null, children: [] });
  });
});

describe('the salu tools', () => {
  test('status replaces the whole checklist', () => {
    const t = mk('a', 'x');
    expect(callTool(ctx(t.id), 'status', { items: [{ text: 'one', state: 'doing' }, { text: 'two', state: 'todo' }] }).error).toBeUndefined();
    callTool(ctx(t.id), 'status', { items: [{ text: 'one', state: 'done' }] });
    expect(getChecklist(db, t.id)).toEqual([{ text: 'one', state: 'done' }]);
  });

  test('bad input is an error result, never a throw', () => {
    const t = mk('a', 'x');
    expect(callTool(ctx(t.id), 'status', { items: [] }).error).toBe(true);
    expect(callTool(ctx(t.id), 'status', { items: [{ text: 'a', state: 'weird' }] }).error).toBe(true);
    expect(callTool(ctx(t.id), 'nope', {}).error).toBe(true);
    expect(callTool(ctx(t.id), 'ask_decision', { question: 'q', options: [{ label: 'a', consequence: 'x' }, { label: 'b', consequence: 'y' }], recommended: 2 }).error).toBe(true);
  });

  test('ask_decision records an open decision and tells the worker to carry on', () => {
    const t = mk('a', 'x');
    const r = callTool(ctx(t.id), 'ask_decision', { question: 'Which db?', options: [{ label: 'pg', consequence: 'fast' }, { label: 'sqlite', consequence: 'simple' }], recommended: 1 });
    expect(r.text).toContain('sqlite');
    const [d] = listDecisions(db, t.id);
    expect(d).toMatchObject({ question: 'Which db?', recommended: 1, status: 'open', chosen: null });
    expect(d!.options).toHaveLength(2);
  });

  test('attach dedupes, and pr/link need a URL', () => {
    const t = mk('a', 'x');
    callTool(ctx(t.id), 'attach', { kind: 'branch', ref: 'salu/a' });
    callTool(ctx(t.id), 'attach', { kind: 'branch', ref: 'salu/a', title: 'the work' });
    expect(listOutputs(db, t.id).map((o) => [o.kind, o.ref, o.title])).toEqual([['branch', 'salu/a', 'the work']]);
    expect(callTool(ctx(t.id), 'attach', { kind: 'pr', ref: 'not a url' }).error).toBe(true);
    expect(callTool(ctx(t.id), 'attach', { kind: 'pr', ref: 'https://github.com/o/r/pull/1' }).error).toBeUndefined();
  });

  test('control characters are stripped before storing', () => {
    const t = mk('a', 'x');
    callTool(ctx(t.id), 'attach', { kind: 'file', ref: 'a\u001b[31m.txt', title: 'x\u0007y' });
    const [o] = listOutputs(db, t.id);
    expect(o!.ref).not.toContain('\u001b');
    expect(o!.title).not.toContain('\u0007');
  });

  test('start_thread makes a queued child with the parent link and inherited tags', () => {
    const t = mk('parent', 'x', { permission: 'plan', tools: 'readonly', model: 'opus' });
    const r = callTool(ctx(t.id), 'start_thread', { name: 'Sub Task', prompt: 'do it', effort: 'high' });
    expect(r.error).toBeUndefined();
    const [c] = listChildren(db, t.id);
    const child = getTicketById(db, c!.id)!;
    expect(child).toMatchObject({ name: 'sub-task', status: 'todo', parent_id: t.id, query: 'do it' });
    expect(JSON.parse(child.tags)).toEqual({ permission: 'plan', tools: 'readonly', model: 'opus', effort: 'high' });
    expect(threadSummary(db, c!.id).parent).toMatchObject({ id: t.id, name: 'parent' });
    // same name again gets a suffix
    callTool(ctx(t.id), 'start_thread', { name: 'sub task', prompt: 'again' });
    expect(listChildren(db, t.id).map((x) => x.name)).toEqual(['sub-task', 'sub-task-2']);
  });

  test('start_thread cannot widen permissions, and is capped in depth and fan-out', () => {
    const t = mk('p', 'x');
    expect(callTool(ctx(t.id), 'start_thread', { name: 'k', prompt: 'x', permission: 'bypass' } as any).error).toBeUndefined();
    expect(JSON.parse(listTickets(db, {}).find((x) => x.name === 'k')!.tags).permission).toBeUndefined();
    expect(callTool(ctx(t.id), 'start_thread', { name: 'bad', prompt: 'x', model: 'not a model!' }).error).toBe(true);
    // depth: p -> a -> b, b may not start more
    callTool(ctx(t.id), 'start_thread', { name: 'a', prompt: 'x' });
    const a = listTickets(db, {}).find((x) => x.name === 'a')!;
    callTool(ctx(a.id), 'start_thread', { name: 'b', prompt: 'x' });
    const b = listTickets(db, {}).find((x) => x.name === 'b')!;
    expect(callTool(ctx(b.id), 'start_thread', { name: 'c', prompt: 'x' }).error).toBe(true);
    // fan-out
    const f = mk('fan', 'x');
    for (let i = 0; i < MAX_CHILDREN; i++) expect(callTool(ctx(f.id), 'start_thread', { name: `c${i}`, prompt: 'x' }).error).toBeUndefined();
    expect(callTool(ctx(f.id), 'start_thread', { name: 'one-more', prompt: 'x' }).error).toBe(true);
  });

  test('deleting a parent keeps its children', () => {
    const t = mk('p', 'x');
    callTool(ctx(t.id), 'start_thread', { name: 'kid', prompt: 'x' });
    db.run('DELETE FROM tickets WHERE id = ?', [t.id]);
    expect(getTicketById(db, listTickets(db, {})[0]!.id)!.parent_id).toBeNull();
  });
});

describe('workers', () => {
  test('a fake run posts a checklist, a decision and an output, then the next run clears the checklist', async () => {
    const t = mk('w', script([
      { tool: 'status', args: { items: [{ text: 'a', state: 'done' }, { text: 'b', state: 'doing' }] } },
      { tool: 'ask_decision', args: { question: 'q?', options: [{ label: 'x', consequence: 'cx' }, { label: 'y', consequence: 'cy' }], recommended: 0 } },
      { tool: 'attach', args: { kind: 'branch', ref: 'salu/w' } },
    ], 'FAKE:done all good'));
    await run();
    expect(getTicketById(db, t.id)!.status).toBe('done');
    expect(getChecklist(db, t.id)).toHaveLength(2);
    expect(listDecisions(db, t.id)).toHaveLength(1);
    expect(listOutputs(db, t.id)).toHaveLength(1);
    replyToTicket(db, t.id, 'FAKE:done again');
    await run();
    expect(getChecklist(db, t.id)).toEqual([]);
    expect(listDecisions(db, t.id)).toHaveLength(1); // decisions and outputs stay
  });

  test('a sub-thread started by a worker runs', async () => {
    const t = mk('boss', script([{ tool: 'start_thread', args: { name: 'minion', prompt: 'FAKE:done minion done' } }], 'FAKE:done delegated'));
    await run();
    const kid = listTickets(db, {}).find((x) => x.name === 'minion')!;
    expect(kid.parent_id).toBe(t.id);
    expect(kid.status).toBe('done');
  });

  test('worker options carry the salu tool prompt unless tools=none', () => {
    const t = mk('o', 'x');
    const v = getTicketById(db, t.id)!;
    expect((workerSdkOptions(v, null).systemPrompt as any).append).toContain('mcp__salu__');
    expect(saluToolOn(v, null)).toBe(true);
    const none = { ...v, tags: JSON.stringify({ tools: 'none' }) };
    expect(saluToolOn(none, null)).toBe(false);
    expect((workerSdkOptions(none, null).systemPrompt as any).append).not.toContain('mcp__salu__');
  });

  test('the MCP server exposes every tool', async () => {
    const t = mk('m', 'x');
    const server: any = await saluMcpServer(db, getTicketById(db, t.id)!);
    expect(server.type).toBe('sdk');
    expect(server.name).toBe('salu');
    expect(TOOL_NAMES).toEqual(TOOLS.map((x) => `mcp__salu__${x.name}`));
  });
});

describe('answering decisions', () => {
  const decide = () => {
    const t = mk('d', script([{ tool: 'ask_decision', args: { question: 'which?', options: [{ label: 'one', consequence: 'c1' }, { label: 'two', consequence: 'c2' }], recommended: 0 } }], 'FAKE:done went with one'));
    return t;
  };

  test('picking the recommended option only records it', async () => {
    const t = decide();
    await run();
    const [d] = listDecisions(db, t.id);
    const r = answerAndNotify(db, t.id, d!.id, 0);
    expect(r.ticket).toBeNull();
    expect(listDecisions(db, t.id)[0]).toMatchObject({ status: 'answered', chosen: 0 });
    expect(getTicketById(db, t.id)!.status).toBe('done');
  });

  test('picking another option tells the worker and requeues a finished ticket', async () => {
    const t = decide();
    await run();
    const [d] = listDecisions(db, t.id);
    answerAndNotify(db, t.id, d!.id, 1);
    expect(getTicketById(db, t.id)!.status).toBe('todo');
    expect(listTurns(db, t.id).at(-1)!.body).toContain('"two"');
    expect(() => answerAndNotify(db, t.id, d!.id, 5)).toThrow('pick a number');
  });

  test('CLI: reply --pick, then show prints the checklist, decision and outputs', async () => {
    const t = mk('cli', script([
      { tool: 'status', args: { items: [{ text: 'step', state: 'done' }] } },
      { tool: 'ask_decision', args: { question: 'which?', options: [{ label: 'one', consequence: 'c1' }, { label: 'two', consequence: 'c2' }], recommended: 0 } },
      { tool: 'attach', args: { kind: 'pr', ref: 'https://github.com/o/r/pull/9', title: 'the PR' } },
    ], 'FAKE:done ok'));
    await run();
    const lines: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.join(' '));
    try {
      expect(await dispatch(['show', 'cli'])).toBe(0);
      const text = lines.join('\n');
      expect(text).toContain('✓ step');
      expect(text).toContain('which?');
      expect(text).toContain('(recommended)');
      expect(text).toContain('https://github.com/o/r/pull/9');
      lines.length = 0;
      expect(await dispatch(['reply', 'cli', '--pick', '2'])).toBe(0);
      expect(lines.join('\n')).toContain('two');
      lines.length = 0;
      expect(await dispatch(['show', 'cli', '--json'])).toBe(0);
      const j = JSON.parse(lines.join('\n'));
      expect(j.decisions[0]).toMatchObject({ status: 'answered', chosen: 1 });
      expect(j.checklist).toHaveLength(1);
      await expect(dispatch(['reply', 'cli', '--pick', '1'])).rejects.toThrow('no open decision');
    } finally {
      console.log = log;
    }
  });

  test('typed words answer all open decisions', async () => {
    const t = decide();
    await run();
    expect(await dispatch(['reply', 'd', 'use', 'three', 'instead'])).toBe(0);
    expect(listDecisions(db, t.id)[0]).toMatchObject({ status: 'answered', chosen: null, answer_text: 'use three instead' });
  });
});
