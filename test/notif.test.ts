import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeDb, openDb } from '../src/db/db.ts';
import { createProject, createTicket } from '../src/db/queries.ts';
import { Orchestrator } from '../src/orchestrator/scheduler.ts';
import { fakeRunner } from '../src/orchestrator/fake.ts';
import { dispatch } from '../src/cli/dispatch.ts';
import { newId } from '../src/sync/format.ts';
import { getRemote, setRemote, storeIncomingMessage, unreadCount } from '../src/sync/store.ts';
import { syncProject } from '../src/sync/sync.ts';
import { git } from '../src/sync/git.ts';
import {
  cleanText,
  countUnread,
  getNotif,
  listNotifs,
  markAllRead,
  markRead,
  notifText,
  notifyProblem,
  postLocal,
  resolveNotifId,
  shortId,
} from '../src/notif/index.ts';

let home: string;
let db: ReturnType<typeof openDb>;
let web: ReturnType<typeof createProject>;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ['SALU_HOME', 'SALU_WORKER', 'NO_COLOR', 'SALU_SYNC_DIR', 'SALU_NO_FETCH', 'SALU_BOX_NAME', 'SALU_REMOTE_ALLOW_UNSIGNED', 'SALU_REMOTE_KEY']) saved[k] = process.env[k];
  home = mkdtempSync(join(tmpdir(), 'salu-notif-'));
  process.env.SALU_HOME = home;
  process.env.SALU_WORKER = 'fake';
  process.env.SALU_NO_FETCH = '1';
  process.env.SALU_REMOTE_ALLOW_UNSIGNED = '1'; // these tests are about notifications, not signing
  delete process.env.SALU_REMOTE_KEY;
  closeDb();
  db = openDb();
  web = createProject(db, { name: 'web', path: home });
});
afterEach(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function cli(...argv: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.map(String).join(' '));
  try {
    const code = await dispatch(argv);
    return { code, out: lines.join('\n') };
  } finally {
    console.log = log;
  }
}

describe('reading', () => {
  test('messages are listed newest first, unread until marked, and filtered by project', () => {
    const api = createProject(db, { name: 'api', path: home + '/api' });
    postLocal(db, web.id, { type: 'ticket.done', level: 'success', title: 'first' });
    postLocal(db, api.id, { type: 'ticket.blocked', level: 'warn', title: 'second', question: 'postgres or sqlite?' });
    postLocal(db, web.id, { type: 'ticket.failed', level: 'error', title: 'third' });
    const all = listNotifs(db, { unread: true });
    expect(all.map((n) => n.title)).toEqual(['third', 'second', 'first']);
    expect(countUnread(db)).toBe(3);
    expect(listNotifs(db, { projectId: api.id }).map((n) => n.title)).toEqual(['second']);
    expect(markRead(db, [all[0]!.id])).toBe(1);
    expect(markRead(db, [all[0]!.id])).toBe(0);
    expect(listNotifs(db, { unread: true }).length).toBe(2);
    expect(listNotifs(db).length).toBe(3);
    expect(markAllRead(db, api.id)).toBe(1);
    expect(markAllRead(db)).toBe(1);
    expect(countUnread(db)).toBe(0);
  });

  test('ids resolve from the short code, a prefix or the whole id', () => {
    postLocal(db, web.id, { type: 'note', level: 'info', title: 'a' });
    const n = listNotifs(db)[0]!;
    expect(resolveNotifId(db, shortId(n))).toBe(n.id);
    expect(resolveNotifId(db, '#' + shortId(n).slice(0, 4))).toBe(n.id);
    expect(resolveNotifId(db, n.id)).toBe(n.id);
    expect(resolveNotifId(db, 'zzzz')).toBeNull();
    expect(getNotif(db, n.id)?.title).toBe('a');
  });

  test('notifText gives the question or body, the result branch and the resume time', () => {
    const now = Date.now();
    postLocal(db, web.id, { type: 'ticket.blocked', level: 'warn', title: 't', question: 'which db?', branch: 'salu/x', until: now + 3600_000 });
    const lines = notifText(listNotifs(db)[0]!, now);
    expect(lines[0]).toBe('which db?');
    expect(lines[1]).toBe('result: branch salu/x');
    expect(lines[2]).toMatch(/^resumes at /);
  });

  test('a message that arrives twice is stored once', () => {
    const id = newId();
    const m = { v: 1 as const, id, project: 'web', from: 'box', at: Number(id.slice(0, 13)), type: 'ticket.done' as const, level: 'success' as const, title: 'done' };
    expect(storeIncomingMessage(db, web.id, m)).toBe(true);
    expect(storeIncomingMessage(db, web.id, m)).toBe(false);
    expect(unreadCount(db)).toBe(1);
  });
});

describe('the box stopped note', () => {
  test('an error note from the transport reads sensibly in salu notif', async () => {
    process.env.NO_COLOR = '1';
    const { recordRemoteEvent } = await import('../src/sync/events.ts');
    setRemote(db, { project_id: web.id, url: 'file:///x', role: 'box', name: 'vps' });
    recordRemoteEvent(db, { type: 'environment', message: 'Claude Code is not logged in' } as any);
    // what a client stores once synced
    const row = db.query<{ id: string; body: string }, []>("SELECT id, body FROM remote_messages WHERE direction = 'out'").get()!;
    storeIncomingMessage(db, web.id, { ...JSON.parse(row.body), id: newId() });
    const n = listNotifs(db)[0]!;
    expect(n).toMatchObject({ type: 'note', level: 'error' });
    const out = (await cli('notif', '--plain', '--no-fetch')).out;
    expect(out).toContain('The box stopped: Claude Code is not logged in');
    expect(out).toContain('salu runner restart web');
  });
});

describe('terminal escapes', () => {
  const OSC52 = '\u001b]52;c;ZXZpbA==\u0007';
  test('cleanText drops escapes and control characters, keeps newlines and tabs only for bodies', () => {
    expect(cleanText(`a${OSC52}b\u009bc\r\u202ed`)).toBe('a]52;c;ZXZpbA==bc d');
    expect(cleanText('x\ny\tz')).toBe('x y z');
    expect(cleanText('x\ny\tz', true)).toBe('x\ny\tz');
    expect(cleanText('x\r\ny', true)).toBe('x\ny');
  });

  test('a stored message with escapes is clean everywhere it is read', async () => {
    postLocal(db, web.id, { type: 'note', level: 'error', title: `t${OSC52}itle`, body: `line1\nli${OSC52}ne2`, branch: `salu/a\u001b[2Jb`, ticket: { name: `n\u001b[31mame`, id: 1 } });
    const n = listNotifs(db)[0]!;
    for (const v of [n.title, n.body, n.branch, n.ticket?.name, JSON.stringify(notifText(n))]) expect(v).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    expect(n.body).toContain('\n');
    process.env.NO_COLOR = '1';
    const esc = /\u001b/;
    expect(esc.test((await cli('notif', '--plain', '--no-fetch')).out)).toBe(false);
    expect(esc.test((await cli('notif', '--json', '--no-fetch')).out)).toBe(false);
  });
});

describe('a local orchestrator posts', () => {
  async function runOne(query: string) {
    createTicket(db, { status: 'todo', project_id: web.id, name: 'job', query });
    const orch = new Orchestrator({ db, concurrency: 1, exitWhenEmpty: true, heartbeatMs: 100, runner: fakeRunner });
    await orch.start();
    return listNotifs(db);
  }

  test('a finished ticket posts a done message', async () => {
    const n = await runOne('FAKE:done all good');
    expect(n.length).toBe(1);
    expect(n[0]).toMatchObject({ project: 'web', type: 'ticket.done', level: 'success', ticket: { name: 'job' } });
  });

  test('a blocked ticket posts its question', async () => {
    const n = await runOne('FAKE:blocked which database should I use?');
    expect(n.length).toBe(1);
    expect(n[0]).toMatchObject({ type: 'ticket.blocked', level: 'warn', question: 'which database should I use?' });
  });

  test('a ticket that failed for good posts once; its retry stays silent', async () => {
    const n = await runOne('FAKE:failed cannot reach the database');
    expect(n.length).toBe(1);
    expect(n[0]).toMatchObject({ type: 'ticket.failed', level: 'error', body: 'cannot reach the database' });
  });

  test('a problem that stops the orchestrator posts a note', () => {
    notifyProblem(db, web.id, 'The orchestrator stopped', 'Claude Code is not logged in');
    expect(listNotifs(db)[0]).toMatchObject({ type: 'note', level: 'error', body: 'Claude Code is not logged in' });
  });

  test('on a box the transport queues the message for the client; nothing is stored as read-here', async () => {
    setRemote(db, { project_id: web.id, url: 'file:///nowhere', role: 'box', name: 'box' });
    expect(getRemote(db, web.id)?.role).toBe('box');
    const n = await runOne('FAKE:done fine');
    expect(n.length).toBe(0);
    const queued = db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM remote_messages WHERE direction = 'out'").get()!.c;
    expect(queued).toBeGreaterThan(0);
  });
});

describe('from a box, end to end', () => {
  test('a ticket finished on the box shows up in salu notif on this computer', async () => {
    const bare = join(home, 'remote.git');
    git(home, ['init', '-q', '--bare', bare]);
    // the box
    process.env.SALU_BOX_NAME = 'vps';
    const boxDb = openDb(join(home, 'box.db'));
    const boxPath = join(home, 'box-web');
    git(home, ['init', '-q', boxPath]);
    const boxProject = createProject(boxDb, { name: 'web', path: boxPath });
    setRemote(boxDb, { project_id: boxProject.id, url: bare, role: 'box', name: 'vps' });
    createTicket(boxDb, { status: 'todo', project_id: boxProject.id, name: 'nightly', query: 'FAKE:blocked ok to delete the old table?' });
    await new Orchestrator({ db: boxDb, concurrency: 1, exitWhenEmpty: true, heartbeatMs: 100, runner: fakeRunner }).start();
    process.env.SALU_SYNC_DIR = join(home, 'box-sync');
    syncProject(boxDb, boxProject);
    // this computer
    setRemote(db, { project_id: web.id, url: bare, role: 'client', name: '' });
    process.env.SALU_SYNC_DIR = join(home, 'client-sync');
    expect(syncProject(db, web).messagesReceived).toBeGreaterThan(0);
    boxDb.close();

    process.env.NO_COLOR = '1';
    const out = (await cli('notif', '--plain', '--no-fetch')).out;
    expect(out).toContain('"nightly" needs you');
    expect(out).toContain('ok to delete the old table?');
    const blocked = listNotifs(db).find((n) => n.type === 'ticket.blocked')!;
    expect(blocked.from).toBe('vps');
  });
});

describe('salu notif', () => {
  test('lists unread without marking them, read --all empties it, --all still shows read ones', async () => {
    process.env.NO_COLOR = '1';
    postLocal(db, web.id, { type: 'ticket.done', level: 'success', title: 'Done: "fix"', ticket: { name: 'fix', id: 1 } });
    postLocal(db, web.id, { type: 'ticket.blocked', level: 'warn', title: 'which db?', question: 'postgres or sqlite?' });
    const a = await cli('notif', '--plain', '--no-fetch');
    expect(a.out).toContain('Done: "fix"');
    expect(a.out).toContain('postgres or sqlite?');
    expect(a.out).toContain('2 unread');
    expect(countUnread(db)).toBe(2);
    expect((await cli('notif', 'read', '--all')).out).toContain('marked 2 messages read');
    expect((await cli('notif', '--plain', '--no-fetch')).out).toContain('no unread messages');
    expect((await cli('notif', '--plain', '--no-fetch', '--all')).out).toContain('which db?');
  });

  test('read <id> marks one; a bad id is an error; add posts by hand', async () => {
    process.env.NO_COLOR = '1';
    await cli('notif', 'add', 'hello there', '--project', 'web', '--level', 'success');
    await expect(cli('notif', 'add', 'x', '--project', 'web', '--level', 'bogus')).rejects.toThrow(/level must be/);
    await expect(cli('notif', 'read', 'zzzz')).rejects.toThrow(/no such message/);
    const n = listNotifs(db)[0]!;
    expect((await cli('notif', 'read', '#' + shortId(n))).out).toContain('marked 1 message read');
    expect(countUnread(db)).toBe(0);
  });

  test('--json prints the messages; --project narrows them', async () => {
    const api = createProject(db, { name: 'api', path: home + '/api' });
    postLocal(db, web.id, { type: 'ticket.done', level: 'success', title: 'x' });
    postLocal(db, api.id, { type: 'ticket.done', level: 'success', title: 'y' });
    const j = JSON.parse((await cli('notif', '--json', '--no-fetch', '--project', 'api')).out);
    expect(j.length).toBe(1);
    expect(j[0]).toMatchObject({ project: 'api', title: 'y', read_at: null });
  });
});
