import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { statSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../src/db/db.ts';
import { addTurn, listTurns, replyToTicket, claimNextTicket, createProject, createTicket, getTicketById, listTickets, updateTicket } from '../src/db/queries.ts';
import { addRemoteTicket, enqueueMessage, listNotifications, markRead, setRemote, unreadCount } from '../src/sync/store.ts';
import { rotateKey, publishReply, publishTicket, syncProject } from '../src/sync/sync.ts';
import { recordRemoteEvent } from '../src/sync/events.ts';
import { keyFilePath, remoteKey, saveKey, unsignedWarning, signFile, stripControl, parseReplyFile, parseMessageFile, parseTicketFile, newId } from '../src/sync/format.ts';
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
  process.env.SALU_HOME = join(root, 'home'); // no real key file
  process.env.SALU_REMOTE_ALLOW_UNSIGNED = '1'; // most tests are about the transport, not signing
  delete process.env.SALU_REMOTE_KEY;
  bare = join(root, 'remote.git');
  git(root, ['init', '-q', '--bare', bare]);
  client = side('client', 'client');
  box = side('box', 'box');
});
afterEach(() => {
  client.db.close();
  box.db.close();
  delete process.env.SALU_SYNC_DIR;
  delete process.env.SALU_HOME;
  delete process.env.SALU_REMOTE_ALLOW_UNSIGNED;
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
    expect(tags).toEqual({});
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
    expect(parseReplyFile(JSON.stringify({ v: 1, id: newId(), ticket: { id: 4, name: 'x' }, body: 'hi' }))).toMatchObject({ ticketId: 4, name: 'x' });
    expect(parseReplyFile(JSON.stringify({ v: 1, id: newId(), name: 'x', body: '  ' }))).toBeNull();
  });
});

describe('required signing key', () => {
  test('sync refuses without a key unless unsigned is explicitly allowed', () => {
    delete process.env.SALU_REMOTE_ALLOW_UNSIGNED;
    sendTicket('needs key');
    expect(() => sync(client)).toThrow(/no signing key/);
    expect(() => sync(box)).toThrow(/no signing key/);
    process.env.SALU_REMOTE_ALLOW_UNSIGNED = '1';
    expect(sync(client).ticketsSent).toBe(1);
  });

  test('a key saved in the key file is used, and the environment wins', () => {
    delete process.env.SALU_REMOTE_ALLOW_UNSIGNED;
    expect(remoteKey()).toBeNull();
    saveKey('file-key-0123456789');
    expect(remoteKey()).toBe('file-key-0123456789');
    expect(statSync(keyFilePath()).mode & 0o777).toBe(0o600);
    sendTicket('keyed');
    expect(sync(client).ticketsSent).toBe(1);
    expect(sync(box).ticketsReceived).toBe(1);
    process.env.SALU_REMOTE_KEY = 'env-key-0123456789ab';
    try {
      expect(remoteKey()).toBe('env-key-0123456789ab');
    } finally {
      delete process.env.SALU_REMOTE_KEY;
    }
  });

  test('salu remote add --box makes and shows a key; the client needs it', () => {
    const run = (home: string, ...args: string[]) =>
      Bun.spawnSync(['bun', join(import.meta.dir, '../src/index.ts'), ...args], { cwd: join(root, home + '-web'), env: { ...process.env, SALU_HOME: join(root, home + '-home'), SALU_REMOTE_ALLOW_UNSIGNED: '' } as Record<string, string>, stdout: 'pipe', stderr: 'pipe' });
    const text = (r: ReturnType<typeof run>) => r.stdout.toString() + r.stderr.toString();
    run('client', 'add', 'project', 'web', '.');
    run('box', 'add', 'project', 'web', '.');
    const b = run('box', 'remote', 'add', 'web', bare, '--box');
    expect(b.exitCode).toBe(0);
    const key = /\n {2}([0-9a-f]{64})\n/.exec(text(b))?.[1];
    expect(key).toBeTruthy();
    expect(run('box', 'remote', 'key').stdout.toString().trim()).toBe(key!);
    const noKey = run('client', 'remote', 'add', 'web', bare);
    expect(noKey.exitCode).not.toBe(0);
    expect(text(noKey)).toContain('signing key');
    const c = run('client', 'remote', 'add', 'web', bare, '--key', key!);
    expect(c.exitCode).toBe(0);
    expect(run('client', 'remote', 'key').stdout.toString().trim()).toBe(key!);
    expect(run('client', 'remote', 'key', '--set', 'short').exitCode).not.toBe(0);
  });
});

describe('key rotation', () => {
  test('rotating on the box re-signs the history so a client with the new key sees all of it', () => {
    delete process.env.SALU_REMOTE_ALLOW_UNSIGNED;
    process.env.SALU_REMOTE_KEY = 'old-key-0123456789ab';
    try {
      sendTicket('history');
      sync(client);
      sync(box); // accepted message
      const run = claimNextTicket(box.db)!;
      recordRemoteEvent(box.db, { type: 'dispatch', ticket: run, runId: 1, resumed: false });
      sync(box);
      // A pusher plants a file that was never signed with the old key.
      const evil = join(root, 'evil4');
      git(root, ['clone', '-q', '--branch', 'salu/inbox', bare, evil]);
      const forged = { v: 1, id: newId(), project: 'web', from: 'box', at: 1, type: 'ticket.done', level: 'success', title: 'forged' };
      writeFileSync(join(evil, 'salu-inbox', 'messages', `${forged.id}.json`), JSON.stringify({ ...forged, sig: 'f'.repeat(64) }));
      git(evil, ['add', '-A']);
      git(evil, ['-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-qm', 'forged']);
      git(evil, ['push', '-q', 'origin', 'HEAD:refs/heads/salu/inbox']);

      process.env.SALU_SYNC_DIR = box.sync;
      const r = rotateKey(box.db, 'old-key-0123456789ab', 'new-key-0123456789ab');
      expect(r).toEqual([{ project: 'web', resigned: 3 }]); // the ticket and two messages; the forgery is left alone

      // The client switches to the new key and has never synced: it sees the full history, not the forgery.
      process.env.SALU_REMOTE_KEY = 'new-key-0123456789ab';
      const s = sync(client);
      expect(s.messagesReceived).toBe(2);
      expect(listNotifications(client.db).map((n) => n.title)).not.toContain('forged');
      // Rotating again to the same key changes nothing.
      process.env.SALU_SYNC_DIR = box.sync;
      expect(rotateKey(box.db, 'old-key-0123456789ab', 'new-key-0123456789ab')).toEqual([{ project: 'web', resigned: 0 }]);
    } finally {
      delete process.env.SALU_REMOTE_KEY;
    }
  });

  test('salu remote key --new on a box re-signs; on a client it only saves', () => {
    const run = (home: string, ...args: string[]) =>
      Bun.spawnSync(['bun', join(import.meta.dir, '../src/index.ts'), ...args], { cwd: join(root, home + '-web'), env: { ...process.env, SALU_HOME: join(root, home + '-home'), SALU_SYNC_DIR: join(root, home + '-syncdir'), SALU_REMOTE_ALLOW_UNSIGNED: '' } as Record<string, string>, stdout: 'pipe', stderr: 'pipe' });
    const text = (r: ReturnType<typeof run>) => r.stdout.toString() + r.stderr.toString();
    run('box', 'add', 'project', 'web', '.');
    const added = text(run('box', 'remote', 'add', 'web', bare, '--box'));
    const k1 = /\n {2}([0-9a-f]{64})\n/.exec(added)![1]!;
    run('box', 'remote', 'sync'); // writes the inbox (README) under k1
    const rot = run('box', 'remote', 'key', '--new');
    expect(rot.exitCode).toBe(0);
    const k2 = /\n {2}([0-9a-f]{64})\n/.exec(text(rot))![1]!;
    expect(k2).not.toBe(k1);
    expect(run('box', 'remote', 'key').stdout.toString().trim()).toBe(k2);
    expect(text(rot)).toContain('re-signed');
  });
});

describe('runner events', () => {
  test('an environment stop becomes an error note with the restart hint', () => {
    recordRemoteEvent(box.db, { type: 'environment', message: 'Claude login expired' } as any);
    sync(box);
    sync(client);
    const n = listNotifications(client.db).at(-1)!;
    expect(n.type).toBe('note');
    expect(n.level).toBe('error');
    expect(n.title).toContain('Claude login expired');
    expect(n.body).toContain('salu runner restart web');
    // Ignored on a machine that is not a box.
    recordRemoteEvent(client.db, { type: 'environment', message: 'x' } as any);
    expect(sync(client).messagesSent).toBe(0);
  });
});

describe('untrusted remote', () => {
  test('control characters are stripped from everything parsed', () => {
    const osc = '\x1b]52;c;ZXZpbA==\x07';
    const m = parseMessageFile(JSON.stringify({ v: 1, id: newId(), type: 'note', title: `hi${osc}`, body: `a${osc}\nb\tc`, ticket: { name: `n${osc}`, id: 1 } }))!;
    expect(m.title).toBe('hi');
    expect(m.body).toBe('a\nb\tc');
    expect(m.ticket!.name).not.toContain('\x1b');
    const t = parseTicketFile(JSON.stringify({ v: 1, id: newId(), name: `x${osc}`, query: `q\x9b31m`, tags: { [`k${osc}`]: `v${osc}` }, labels: [`l${osc}`] }))!;
    expect([t.name, t.query, ...Object.keys(t.tags), ...Object.values(t.tags), ...t.labels].join('')).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
    expect(stripControl('a\u202eb')).toBe('ab');
  });

  test('a symlinked inbox folder on the remote is never written through', () => {
    // A pusher commits salu-inbox/messages as a symlink to a folder outside the sync dir.
    const outside = join(root, 'outside');
    mkdirSync(outside);
    const evil = join(root, 'evil');
    git(root, ['init', '-q', evil]);
    mkdirSync(join(evil, 'salu-inbox'));
    symlinkSync(outside, join(evil, 'salu-inbox', 'messages'));
    git(evil, ['add', '-A']);
    git(evil, ['-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-qm', 'evil']);
    git(evil, ['push', '-q', bare, 'HEAD:refs/heads/salu/inbox']);
    enqueueMessage(box.db, box.project.id, 'web', 'box', { type: 'note', level: 'info', title: 'hello' });
    expect(() => sync(box)).toThrow(/not safe|outside/);
    expect(existsSync(outside) && Bun.spawnSync(['ls', outside]).stdout.toString().trim()).toBe('');
  });

  test('a symlinked top folder or a planted link at the file path is never written through', () => {
    const outside = join(root, 'outside2');
    mkdirSync(outside);
    const evil = join(root, 'evil3');
    git(root, ['init', '-q', evil]);
    symlinkSync(outside, join(evil, 'salu-inbox'));
    git(evil, ['add', '-A']);
    git(evil, ['-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-qm', 'evil']);
    git(evil, ['push', '-q', '-f', bare, 'HEAD:refs/heads/salu/inbox']);
    enqueueMessage(box.db, box.project.id, 'web', 'box', { type: 'note', level: 'info', title: 'hello' });
    expect(() => sync(box)).toThrow(/not safe|outside/);
    expect(Bun.spawnSync(['ls', outside]).stdout.toString().trim()).toBe('');
  });

  test('unsignedWarning is loud without a key and silent with one', () => {
    expect(unsignedWarning({ SALU_REMOTE_ALLOW_UNSIGNED: '1' })).toContain('NOT authenticated');
    expect(unsignedWarning({})).toContain('refuse');
    expect(unsignedWarning({ SALU_REMOTE_KEY: 'k' })).toBeNull();
  });

  test('tags that burn quota are stripped unless the box owner allows them', () => {
    sendTicket('costly', { 'max-turns': '999999', model: 'opus', effort: 'max', perm: 'x' });
    sync(client);
    sync(box);
    expect(JSON.parse(listTickets(box.db)[0]!.tags)).toEqual({ perm: 'x' });
    process.env.SALU_REMOTE_ALLOW_TAGS = 'model, permission';
    try {
      sendTicket('allowed', { model: 'sonnet', permission: 'bypass', effort: 'max' });
      sync(client);
      sync(box);
      expect(JSON.parse(listTickets(box.db).find((t) => t.name === 'allowed')!.tags)).toEqual({ model: 'sonnet' });
    } finally {
      delete process.env.SALU_REMOTE_ALLOW_TAGS;
    }
  });

  test('with SALU_REMOTE_KEY, unsigned or wrongly signed files are ignored', () => {
    const forged = { v: 1, id: newId(), project: 'web', from: 'box', at: Date.now(), type: 'ticket.done', level: 'success', title: 'forged' };
    process.env.SALU_REMOTE_KEY = 'secret-one';
    try {
      const ok = signFile(forged);
      expect(parseMessageFile(JSON.stringify(ok))?.title).toBe('forged');
      expect(parseMessageFile(JSON.stringify(forged))).toBeNull(); // unsigned
      expect(parseMessageFile(JSON.stringify({ ...ok, title: 'edited' }))).toBeNull(); // changed after signing
      process.env.SALU_REMOTE_KEY = 'secret-two';
      expect(parseMessageFile(JSON.stringify(ok))).toBeNull(); // other key
    } finally {
      delete process.env.SALU_REMOTE_KEY;
    }
    expect(parseMessageFile(JSON.stringify(forged))?.title).toBe('forged'); // no key: accepted
  });

  test('a full round trip works with signing on, and a forged ticket is not accepted', () => {
    process.env.SALU_REMOTE_KEY = 'shared';
    try {
      const { t } = sendTicket('signed');
      sync(client);
      expect(sync(box).ticketsReceived).toBe(1);
      sync(client);
      expect(listNotifications(client.db)[0]!.type).toBe('ticket.accepted');
      expect(getTicketById(client.db, t.id)).toBeTruthy();
      // A pusher without the key writes a ticket file straight into the inbox.
      const forged = { v: 1, id: newId(), project: 'web', name: 'evil', query: 'rm -rf', tags: {}, labels: [], priority: 1, queue: true, at: 0 };
      const evil = join(root, 'evil2');
      git(root, ['clone', '-q', '--branch', 'salu/inbox', bare, evil]);
      writeFileSync(join(evil, 'salu-inbox', 'tickets', `${forged.id}.json`), JSON.stringify(forged));
      git(evil, ['add', '-A']);
      git(evil, ['-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-qm', 'forged']);
      git(evil, ['push', '-q', 'origin', 'HEAD:refs/heads/salu/inbox']);
      expect(sync(box).ticketsReceived).toBe(0);
      expect(listTickets(box.db).some((x) => x.name === 'evil')).toBe(false);
    } finally {
      delete process.env.SALU_REMOTE_KEY;
    }
  });
});

void addRemoteTicket;
void writeFileSync;
