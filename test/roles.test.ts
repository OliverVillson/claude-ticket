import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { openDb } from '../src/db/db.ts';
import { createProject, createTicket, getTicketById, listTickets } from '../src/db/queries.ts';
import { ticketLabels } from '../src/db/types.ts';
import { addRemoteTicket, setRemote } from '../src/sync/store.ts';
import { publishAction, publishReply, publishTicket, syncProject } from '../src/sync/sync.ts';
import { git } from '../src/sync/git.ts';
import { addMember } from '../src/team/store.ts';
import { issueKey, setSharedRetired } from '../src/team/keys.ts';
import { whyNot } from '../src/team/perms.ts';
import { createHandlers, VERB_ROLE } from '../src/box/handlers/index.ts';
import { VERBS, commandPath, signMessage } from '../src/control/message.ts';
import { generateSealKeys } from '../src/control/seal.ts';
import { memoryTransport } from '../src/control/transport.ts';
import { runWatcher } from '../src/control/watcher.ts';
import { waitReply, type BoxConfig } from '../src/control/client.ts';
import { newId } from '../src/sync/format.ts';
import { seat, team } from '../src/cli/commands/team.ts';
import { parseArgs } from '../src/cli/args.ts';

const SHARED = 'shared-key-0123456789ab';
let root: string;
let bare: string;
type Side = { db: ReturnType<typeof openDb>; sync: string; project: ReturnType<typeof createProject> };
let box: Side;

function side(name: string, role: 'client' | 'box'): Side {
  const db = openDb(join(root, `${name}.db`));
  const path = join(root, `${name}-web`);
  git(root, ['init', '-q', path]);
  const project = createProject(db, { name: 'web', path });
  setRemote(db, { project_id: project.id, url: bare, role, name });
  return { db, sync: join(root, `${name}-sync`), project };
}
function syncAs(s: Side, key: string) {
  process.env.SALU_SYNC_DIR = s.sync;
  process.env.SALU_REMOTE_KEY = key;
  return syncProject(s.db, s.project);
}
/** A client holding `key` sends a ticket; the box takes it. Returns the client and the ticket's id on the box. */
function addTicket(name: string, key: string, who = name) {
  const c = side(`c-${name}`, 'client');
  const t = createTicket(c.db, { project_id: c.project.id, name, query: 'do it', tags: {}, status: 'todo' });
  publishTicket(c.db, c.project, t, { queue: true });
  syncAs(c, key);
  syncAs(box, SHARED);
  const onBox = listTickets(box.db, { project_id: box.project.id } as any).find((x: any) => x.name === name)!;
  // let the client learn the ticket's state so it can resolve
  syncAs(c, key);
  return { c, t, onBox, who };
}
const status = (id: number) => getTicketById(box.db, id)!.status;
const notes = () => box.db.query<{ body: string }, []>("SELECT body FROM remote_messages WHERE direction = 'out'").all().map((r) => JSON.parse(r.body).title as string);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'salu-roles-'));
  mkdirSync(join(root, 'home'));
  process.env.SALU_HOME = join(root, 'home');
  delete process.env.SALU_REMOTE_ALLOW_UNSIGNED;
  bare = join(root, 'remote.git');
  git(root, ['init', '-q', '--bare', bare]);
  box = side('box', 'box');
  addMember(box.db, box.project.id, 'Alice'); // the first one owns the project
  addMember(box.db, box.project.id, 'Bob');
  addMember(box.db, box.project.id, 'Carol');
});
afterEach(() => {
  box.db.close();
  for (const k of ['SALU_SYNC_DIR', 'SALU_REMOTE_KEY', 'SALU_HOME']) delete process.env[k];
  rmSync(root, { recursive: true, force: true });
});

/** The client resolves or reopens its copy of the ticket and sends it; the box reads it. */
function act(s: { c: Side; t: any }, key: string, action: 'resolve' | 'reopen') {
  publishAction(s.c.db, s.c.project, getTicketById(s.c.db, s.t.id)!, action);
  syncAs(s.c, key);
  syncAs(box, SHARED);
}

describe('what a member may do', () => {
  test('a member adds tickets, marked as theirs; a file cannot claim to be someone else\'s', () => {
    const bob = issueKey(box.db, box.project.id, 'Bob');
    const c = side('c', 'client');
    const t = createTicket(c.db, { project_id: c.project.id, name: 'mine', query: 'q', tags: {}, labels: ['by-alice', 'ui'], status: 'todo' });
    publishTicket(c.db, c.project, t, { queue: true });
    syncAs(c, bob.token);
    syncAs(box, SHARED);
    const onBox = listTickets(box.db, { project_id: box.project.id } as any).find((x: any) => x.name === 'mine')!;
    expect(ticketLabels(onBox)).toEqual(['ui', 'by-bob']);
  });

  test('a member resolves and reopens their own ticket, not someone else\'s', () => {
    const bob = issueKey(box.db, box.project.id, 'Bob');
    const carol = issueKey(box.db, box.project.id, 'Carol');
    const mine = addTicket('bobs', bob.token);
    const hers = addTicket('carols', carol.token);
    act(mine, bob.token, 'resolve');
    expect(status(mine.onBox.id)).toBe('done');
    act(mine, bob.token, 'reopen');
    expect(status(mine.onBox.id)).not.toBe('done');
    // Bob's client names Carol's ticket by its ref and asks the box to resolve it
    const c = side('c-forge', 'client');
    const t = createTicket(c.db, { project_id: c.project.id, name: 'carols', query: 'do it', tags: {}, status: 'todo' });
    addRemoteTicket(c.db, { uuid: [...(listRemote(hers.onBox.id))][0]!, project_id: c.project.id, ticket_id: t.id, direction: 'out', queue: true, sent: true });
    publishAction(c.db, c.project, t, 'resolve');
    syncAs(c, bob.token);
    syncAs(box, SHARED);
    expect(status(hers.onBox.id)).not.toBe('done');
    expect(notes().some((n) => /Bob cannot resolve "carols"/.test(n))).toBe(true);
  });

  test('a member replies to any ticket', () => {
    const bob = issueKey(box.db, box.project.id, 'Bob');
    const carol = issueKey(box.db, box.project.id, 'Carol');
    const hers = addTicket('carols', carol.token);
    const b = side('c-bob', 'client');
    const t = createTicket(b.db, { project_id: b.project.id, name: 'carols', query: 'q', tags: {}, status: 'todo' });
    addRemoteTicket(b.db, { uuid: listRemote(hers.onBox.id)[0]!, project_id: b.project.id, ticket_id: t.id, direction: 'out', queue: true, sent: true });
    publishReply(b.db, b.project, t, 'one more thing');
    syncAs(b, bob.token);
    syncAs(box, SHARED);
    expect(notes().some((n) => /Got your reply on "carols"/.test(n))).toBe(true);
  });

  test('the admin resolves anyone\'s ticket', () => {
    const alice = issueKey(box.db, box.project.id, 'Alice');
    const carol = issueKey(box.db, box.project.id, 'Carol');
    const hers = addTicket('carols', carol.token);
    const a = side('c-alice', 'client');
    const t = createTicket(a.db, { project_id: a.project.id, name: 'carols', query: 'q', tags: {}, status: 'todo' });
    addRemoteTicket(a.db, { uuid: listRemote(hers.onBox.id)[0]!, project_id: a.project.id, ticket_id: t.id, direction: 'out', queue: true, sent: true });
    publishAction(a.db, a.project, t, 'resolve');
    syncAs(a, alice.token);
    syncAs(box, SHARED);
    expect(status(hers.onBox.id)).toBe('done');
  });
});

describe('the shared key', () => {
  test('adds tickets and replies but never counts as an admin or as a person', () => {
    const t1 = addTicket('legacy', SHARED);
    expect(ticketLabels(t1.onBox).filter((l) => l.startsWith('by-'))).toEqual([]);
    expect(whyNot(box.db, box.project.id, { name: null, role: null }, 'resolve', ['by-bob'])).toMatch(/shared key cannot resolve/);
    expect(whyNot(box.db, box.project.id, { name: null, role: null }, 'resolve', [])).toBeNull();
  });

  test('cannot resolve a member\'s ticket, even claiming to be them', () => {
    const bob = issueKey(box.db, box.project.id, 'Bob');
    const bobs = addTicket('bobs', bob.token);
    const c = side('c-sh', 'client');
    const t = createTicket(c.db, { project_id: c.project.id, name: 'bobs', query: 'q', tags: {}, status: 'todo' });
    addRemoteTicket(c.db, { uuid: listRemote(bobs.onBox.id)[0]!, project_id: c.project.id, ticket_id: t.id, direction: 'out', queue: true, sent: true });
    publishAction(c.db, c.project, t, 'resolve');
    syncAs(c, SHARED);
    syncAs(box, SHARED);
    expect(status(bobs.onBox.id)).not.toBe('done');
    expect(notes().some((n) => /shared key cannot resolve/.test(n))).toBe(true);
  });

  test('a shared-key ticket cannot be made to look like a member\'s', () => {
    const c = side('c-sh2', 'client');
    const t = createTicket(c.db, { project_id: c.project.id, name: 'fake', query: 'q', tags: {}, labels: ['by-bob'], status: 'todo' });
    publishTicket(c.db, c.project, t, { queue: true });
    syncAs(c, SHARED);
    syncAs(box, SHARED);
    const onBox = listTickets(box.db, { project_id: box.project.id } as any).find((x: any) => x.name === 'fake')!;
    expect(ticketLabels(onBox).some((l) => l.startsWith('by-'))).toBe(false);
  });

  test('a project with no roster behaves as in v1: the shared key may do everything', () => {
    const plain = side('plain', 'box');
    expect(whyNot(plain.db, plain.project.id, { name: null, role: null }, 'resolve', ['by-anyone'])).toBeNull();
  });

  test('retired, it is refused outright', () => {
    setSharedRetired(box.db, box.project.id, true);
    addTicket('x', SHARED);
    expect(listTickets(box.db, { project_id: box.project.id } as any).length).toBe(0);
  });
});

describe('roster, allow list and kernel settings are not on the sync channel', () => {
  test('a ticket cannot carry permission, tools, project, model or effort, whoever sent it', () => {
    const alice = issueKey(box.db, box.project.id, 'Alice');
    const c = side('c-tags', 'client');
    const t = createTicket(c.db, { project_id: c.project.id, name: 'tags', query: 'q', tags: { permission: 'all', tools: 'also:Bash(*)', project: 'x', model: 'm', effort: 'max', 'max-turns': '999', note: 'ok' }, status: 'todo' });
    publishTicket(c.db, c.project, t, { queue: true });
    syncAs(c, alice.token);
    syncAs(box, SHARED);
    const onBox = listTickets(box.db, { project_id: box.project.id } as any).find((x: any) => x.name === 'tags')!;
    const tags = JSON.parse((onBox as any).tags || '{}');
    expect(Object.keys(tags)).toEqual(['note']);
  });

  test('a reply or action file carrying a roster or role is just a reply or action', () => {
    const bob = issueKey(box.db, box.project.id, 'Bob');
    const before = JSON.stringify(box.db.query('SELECT name, role FROM members ORDER BY id').all());
    const c = side('c-role', 'client');
    const t = createTicket(c.db, { project_id: c.project.id, name: 'r', query: 'q', tags: {}, status: 'todo' });
    publishTicket(c.db, c.project, t, { queue: true });
    syncAs(c, bob.token);
    syncAs(box, SHARED);
    expect(JSON.stringify(box.db.query('SELECT name, role FROM members ORDER BY id').all())).toBe(before);
  });

  test('on a computer that sends to a box, the roster cannot be changed', async () => {
    const db = openDb(); // the default database under SALU_HOME, the one the command opens
    const path = join(root, 'cli-web');
    git(root, ['init', '-q', path]);
    const project = createProject(db, { name: 'cliweb', path });
    setRemote(db, { project_id: project.id, url: bare, role: 'client', name: 'x' });
    await expect(team(parseArgs(['add', 'Mallory', '--project', 'cliweb']))).rejects.toThrow(/lives on the box/);
    await expect(seat(parseArgs(['add', 'mine', '--project', 'cliweb']))).rejects.toThrow(/lives on the box/);
    await team(parseArgs(['list', '--project', 'cliweb'])); // reading is fine
    db.close();
  });
});

describe('control channel', () => {
  test('every verb is the admin\'s, and the table has no gaps', () => {
    expect(Object.keys(VERB_ROLE).sort()).toEqual([...VERBS].sort());
    expect(Object.values(VERB_ROLE).every((r) => r === 'admin')).toBe(true);
    expect(Object.keys(createHandlers({ run: async () => ({ ok: true, out: '' }), salu: 'salu', user: 'salu', version: '1', tmpDir: root, now: Date.now })).sort()).toEqual([...VERBS].sort());
  });

  test('a command signed with a member\'s sync key or the shared key is refused', async () => {
    const t = memoryTransport();
    const seal = generateSealKeys();
    const cfg: BoxConfig = { box: 'salubox', macKey: randomBytes(32), boxKey: randomBytes(32), sealPub: seal.publicKey };
    let ran = false;
    const h: any = Object.fromEntries(VERBS.map((v) => [v, async () => ((ran = true), { ok: true, message: 'ran' })]));
    const w = runWatcher(t, h, { box: cfg.box, macKey: cfg.macKey, boxKey: cfg.boxKey, sealKey: seal.privateKey, intervalMs: 3_600_000, handledFile: join(root, 'handled') });
    const bob = issueKey(box.db, box.project.id, 'Bob');
    for (const key of [Buffer.from(SHARED), Buffer.from(bob.token), Buffer.from(bob.token.split('.')[1]!, 'hex')]) {
      const id = newId();
      await t.put(commandPath(cfg.box, id), JSON.stringify(signMessage({ v: 1, id, box: cfg.box, verb: 'update', at: Date.now(), args: {}, sealed: {} }, key)));
      await w.tick();
      const r = await waitReply(t, cfg, id, { timeoutMs: 2000 });
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/bad signature/);
    }
    expect(ran).toBe(false);
    w.stop();
  });
});

/** The ref a ticket on the box was sent with (the client's file id). */
function listRemote(ticketId: number): string[] {
  return box.db.query<{ uuid: string }, [number]>("SELECT uuid FROM remote_tickets WHERE ticket_id = ? AND direction = 'in'").all(ticketId).map((r) => r.uuid);
}
