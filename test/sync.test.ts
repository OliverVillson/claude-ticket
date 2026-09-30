import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../src/db/db.ts';
import { addTurn, listTurns, replyToTicket, claimNextTicket, createProject, createTicket, getTicketById, listTickets, updateTicket } from '../src/db/queries.ts';
import { addRemoteTicket, enqueueMessage, listNotifications, markRead, setRemote, unreadCount } from '../src/sync/store.ts';
import { publishReply, publishTicket, syncProject } from '../src/sync/sync.ts';
import { recordRemoteEvent } from '../src/sync/events.ts';
import { parseReplyFile, parseMessageFile, parseTicketFile, newId } from '../src/sync/format.ts';
import { git } from '../src/sync/git.ts';

let root: string;
let bare: string;
type Side = { db: ReturnType<typeof openDb>; sync: string; project: ReturnType<typeof createProject> };
let client: Side;
let box: Side;

function side(name: string, role: 'client' | 'box'): Side {
  const db = openDb(join(root, `${name}.db`));
  const path = join(root, `${name}-web`);
  git(root, ['init', '-q', path]);
  const project = createProject(db, { name: 'web', path });
  setRemote(db, { project_id: project.id, url: bare, role, name: name });
  return { db, sync: join(root, `${name}-sync`), project };
}
const sync = (s: Side) => {
  process.env.SALU_SYNC_DIR = s.sync;
  return syncProject(s.db, s.project);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'salu-sync-'));
  bare = join(root, 'remote.git');
  git(root, ['init', '-q', '--bare', bare]);
  client = side('client', 'client');
  box = side('box', 'box');
});
afterEach(() => {
  client.db.close();
  box.db.close();
  delete process.env.SALU_SYNC_DIR;
  rmSync(root, { recursive: true, force: true });
});

function sendTicket(name: string, tags: Record<string, string> = {}) {
  const t = createTicket(client.db, { project_id: client.project.id, name, query: `do ${name}`, tags, status: 'todo' });
  return { t, uuid: publishTicket(client.db, client.project, t, { queue: true }) };
}

describe('format', () => {
  test('rejects junk and oversized files', () => {
    expect(parseTicketFile('nope')).toBeNull();
    expect(parseTicketFile(JSON.stringify({ v: 1, id: 'x', name: 'a', query: 'b' }))).toBeNull();
    expect(parseTicketFile(JSON.stringify({ v: 1, id: newId(), name: 'a', query: 'b' }))?.priority).toBe(3);
    expect(parseTicketFile('x'.repeat(70000))).toBeNull();
    expect(parseMessageFile(JSON.stringify({ v: 1, id: newId(), type: 'bogus', title: 't' }))).toBeNull();
    expect(parseMessageFile(JSON.stringify({ v: 1, id: newId(), type: 'note', title: 't' }))?.level).toBe('info');
  });
});

describe('git sync', () => {
  test('a ticket goes to the box, runs there, and the result comes back as messages', () => {
    const { t, uuid } = sendTicket('fix login');
    const s1 = sync(client);
    expect(s1.ticketsSent).toBe(1);
    // The client's copy must not run locally.
    expect(claimNextTicket(client.db)).toBeNull();

    const s2 = sync(box);
    expect(s2.ticketsReceived).toBe(1);
    expect(s2.messagesSent).toBe(1); // ticket.accepted
    const onBox = listTickets(box.db)[0]!;
    expect(onBox.name).toBe('fix login');
    expect(onBox.status).toBe('todo');
    const running = claimNextTicket(box.db)!;
    expect(running.id).toBe(onBox.id);

    recordRemoteEvent(box.db, { type: 'dispatch', ticket: running, runId: 1, resumed: false });
    const done = updateTicket(box.db, running.id, { status: 'done' });
    recordRemoteEvent(box.db, { type: 'finish', ticket: done, outcome: 'done', costUsd: 0, turns: 3, status: 'done' });
    expect(sync(box).messagesSent).toBe(2);

    const s3 = sync(client);
    expect(s3.messagesReceived).toBe(3);
    expect(getTicketById(client.db, t.id)!.status).toBe('done');
    const notes = listNotifications(client.db);
    expect(notes.map((n) => n.type)).toEqual(['ticket.accepted', 'ticket.started', 'ticket.done']);
    expect(notes[2]!.ticket?.ref).toBe(uuid);
    expect(unreadCount(client.db)).toBe(3);
    expect(markRead(client.db, [notes[0]!.id])).toBe(1);
    expect(markRead(client.db, [notes[0]!.id])).toBe(0);
    expect(listNotifications(client.db).length).toBe(2);
    expect(listNotifications(client.db, { all: true }).length).toBe(3);
    expect(markRead(client.db, 'all')).toBe(2);

    // Nothing new: a second round changes nothing.
    expect(sync(client).messagesReceived).toBe(0);
    expect(sync(box).ticketsReceived).toBe(0);
  });

  test('tags that widen permissions are dropped on the box', () => {
    sendTicket('risky', { permission: 'bypass', tools: 'allow:Bash(*)', model: 'sonnet' });
    sync(client);
    sync(box);
    const tags = JSON.parse(listTickets(box.db)[0]!.tags);
    expect(tags).toEqual({ model: 'sonnet' });
  });

  test('both sides pushing at once never conflict', () => {
    sendTicket('one');
    sendTicket('two');
    // The box writes a note first, so the client's push is rejected the first time.
    enqueueMessage(box.db, box.project.id, 'web', 'box', { type: 'note', level: 'info', title: 'hello' });
    sync(box);
    const s = sync(client);
    expect(s.ticketsSent).toBe(2);
    expect(s.messagesReceived).toBe(1);
    expect(sync(box).ticketsReceived).toBe(2);
  });

  test('a duplicate name on the box gets a number; blocked and failed reach the client', () => {
    createTicket(box.db, { project_id: box.project.id, name: 'same', query: 'x' });
    const { t } = sendTicket('same');
    sync(client);
    sync(box);
    expect(listTickets(box.db).map((x) => x.name).sort()).toEqual(['same', 'same (2)']);
    const b = listTickets(box.db).find((x) => x.name === 'same (2)')!;
    recordRemoteEvent(box.db, { type: 'finish', ticket: b, outcome: 'blocked', costUsd: 0, turns: 1, status: 'blocked', error: 'needs permission: Bash(git push *)' });
    sync(box);
    sync(client);
    const local = getTicketById(client.db, t.id)!;
    expect(local.status).toBe('blocked');
    expect(local.error).toContain('git push');
  });

  test('an unreachable remote keeps everything waiting and records the error', () => {
    const { uuid } = sendTicket('later');
    setRemote(client.db, { project_id: client.project.id, url: join(root, 'missing.git'), role: 'client', name: '' });
    expect(() => sync(client)).toThrow();
    setRemote(client.db, { project_id: client.project.id, url: bare, role: 'client', name: '' });
    expect(sync(client).ticketsSent).toBe(1);
    expect(uuid).toBeTruthy();
  });

  test('the box pushes salu/<ticket> branches and the client sees them', () => {
    git(box.project.path, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-qm', 'init']);
    git(box.project.path, ['branch', 'salu/fix-login']);
    const s = sync(box);
    expect(s.branchesPushed).toEqual(['salu/fix-login']);
    expect(git(bare, ['branch', '--list', 'salu/fix-login']).out).toContain('salu/fix-login');
  });
});

describe('replies', () => {
  test('a follow-up reaches the box, resumes the ticket, and the answer comes back with the worker text', () => {
    const { t } = sendTicket('chat');
    sync(client);
    sync(box);
    const run = claimNextTicket(box.db)!;
    addTurn(box.db, run.id, 'assistant', 'First answer: use option A.');
    const done = updateTicket(box.db, run.id, { status: 'done' });
    recordRemoteEvent(box.db, { type: 'finish', ticket: done, outcome: 'done', costUsd: 0, turns: 1, status: 'done' });
    sync(box);
    sync(client);
    // The client sees the worker's reply as the ticket's latest turn.
    expect(listTurns(client.db, t.id).map((x) => x.body)).toEqual(['First answer: use option A.']);
    expect(listNotifications(client.db).find((n) => n.type === 'ticket.done')!.reply).toBe('First answer: use option A.');

    // Reply from the client.
    const local = getTicketById(client.db, t.id)!;
    replyToTicket(client.db, t.id, 'and what about B?');
    expect(publishReply(client.db, client.project, local, 'and what about B?', { now: true })).toBe(true);
    expect(sync(client).repliesSent).toBe(1);
    const s = sync(box);
    expect(s.repliesReceived).toBe(1);
    const onBox = getTicketById(box.db, run.id)!;
    expect(onBox.status).toBe('todo');
    expect(listTurns(box.db, run.id).at(-1)).toMatchObject({ role: 'user', body: 'and what about B?', delivered: 0 });
    // Applied once, even if the box syncs again.
    expect(sync(box).repliesReceived).toBe(0);
    sync(client);
    expect(listNotifications(client.db).at(-1)!.title).toContain('Got your reply');
  });

  test('a reply for a backlog or unknown ticket comes back as a warning', () => {
    const { uuid } = sendTicket('later');
    client.db.run('UPDATE remote_tickets SET queue = 0 WHERE uuid = ?', [uuid]);
    sync(client);
    // Box accepted it as backlog (queue false): replying is refused.
    process.env.SALU_SYNC_DIR = box.sync;
    client.db.run("UPDATE remote_tickets SET sent = 1");
    sync(box);
    expect(listTickets(box.db)[0]!.status).toBe('backlog');
    const { addOutReply } = require('../src/sync/store.ts');
    addOutReply(client.db, client.project.id, { ref: uuid, body: 'hello' });
    addOutReply(client.db, client.project.id, { name: 'no such ticket', body: 'hello' });
    sync(client);
    expect(sync(box).repliesReceived).toBe(2);
    sync(client);
    const titles = listNotifications(client.db).map((n) => n.title);
    expect(titles.some((x) => x.includes('not applied'))).toBe(true);
    expect(titles.some((x) => x.includes('Could not find'))).toBe(true);
  });

  test('reply files are validated', () => {
    expect(parseReplyFile(JSON.stringify({ v: 1, id: newId(), ref: newId(), body: 'hi' }))?.now).toBe(false);
    expect(parseReplyFile(JSON.stringify({ v: 1, id: newId(), body: 'hi' }))).toBeNull(); // no ticket
    expect(parseReplyFile(JSON.stringify({ v: 1, id: newId(), name: 'x', body: '  ' }))).toBeNull();
  });
});

void addRemoteTicket;
void writeFileSync;
