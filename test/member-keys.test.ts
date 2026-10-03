import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../src/db/db.ts';
import { createProject, createTicket, listTickets } from '../src/db/queries.ts';
import { enqueueMessage, setRemote } from '../src/sync/store.ts';
import { publishTicket, syncProject } from '../src/sync/sync.ts';
import { git } from '../src/sync/git.ts';
import { addMember, removeMember } from '../src/team/store.ts';
import { issueKey, revokeKey, setSharedRetired } from '../src/team/keys.ts';
import { listNotifications } from '../src/sync/store.ts';

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
/** Run one sync as `who`, holding `key` (the box holds the shared key). */
function syncAs(s: Side, key: string) {
  process.env.SALU_SYNC_DIR = s.sync;
  process.env.SALU_REMOTE_KEY = key;
  return syncProject(s.db, s.project);
}
function clientSends(name: string, key: string, tag = 'x') {
  const c = side(name, 'client');
  const t = createTicket(c.db, { project_id: c.project.id, name: `${tag}-${name}`, query: 'do it', tags: {}, status: 'todo' });
  publishTicket(c.db, c.project, t, { queue: true });
  syncAs(c, key);
  return c;
}
const boxNames = () => listTickets(box.db, { project_id: box.project.id } as any).map((t: any) => t.name).sort();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'salu-mkeys-'));
  mkdirSync(join(root, 'home'));
  process.env.SALU_HOME = join(root, 'home');
  delete process.env.SALU_REMOTE_ALLOW_UNSIGNED;
  bare = join(root, 'remote.git');
  git(root, ['init', '-q', '--bare', bare]);
  box = side('box', 'box');
  addMember(box.db, box.project.id, 'Alice');
  addMember(box.db, box.project.id, 'Bob');
});
afterEach(() => {
  box.db.close();
  for (const k of ['SALU_SYNC_DIR', 'SALU_REMOTE_KEY', 'SALU_HOME']) delete process.env[k];
  rmSync(root, { recursive: true, force: true });
});

describe('per-person keys', () => {
  test('a member signs with their own key and the box knows who sent it', () => {
    const bob = issueKey(box.db, box.project.id, 'Bob');
    clientSends('c1', bob.token);
    syncAs(box, SHARED);
    expect(boxNames()).toEqual(['x-c1']);
    expect(listTickets(box.db, { project_id: box.project.id } as any)[0]!.labels ?? []).toContain('by-bob');
  });

  test('a file naming a member cannot be claimed by someone with only the shared key', () => {
    const bob = issueKey(box.db, box.project.id, 'Bob');
    const c = side('c2', 'client');
    // forged: kid of Bob, signed with the shared key
    const t = createTicket(c.db, { project_id: c.project.id, name: 'forged', query: 'q', tags: {}, status: 'todo' });
    publishTicket(c.db, c.project, t, { queue: true });
    process.env.SALU_SYNC_DIR = c.sync;
    process.env.SALU_REMOTE_KEY = `${bob.kid}.${'0'.repeat(64)}`;
    syncProject(c.db, c.project);
    syncAs(box, SHARED);
    expect(boxNames()).toEqual([]);
  });

  test('a removed or revoked member is refused; the shared key still works', () => {
    const bob = issueKey(box.db, box.project.id, 'Bob');
    const alice = issueKey(box.db, box.project.id, 'Alice');
    clientSends('b', bob.token);
    clientSends('a', alice.token);
    clientSends('old', SHARED);
    removeMember(box.db, box.project.id, 'Bob');
    revokeKey(box.db, box.project.id, 'Alice');
    syncAs(box, SHARED);
    expect(boxNames()).toEqual(['x-old']); // only the shared-key ticket
  });

  test('reissuing a key replaces the old one', () => {
    const k1 = issueKey(box.db, box.project.id, 'Bob');
    issueKey(box.db, box.project.id, 'Bob');
    clientSends('c', k1.token);
    syncAs(box, SHARED);
    expect(boxNames()).toEqual([]);
  });

  test('retiring the shared key refuses it, personal keys keep working', () => {
    const bob = issueKey(box.db, box.project.id, 'Bob');
    clientSends('old', SHARED);
    clientSends('new', bob.token);
    setSharedRetired(box.db, box.project.id, true);
    syncAs(box, SHARED);
    expect(boxNames()).toEqual(['x-new']);
  });

  test('a client with only its own key reads the box messages; with a revoked key it does not', () => {
    const bob = issueKey(box.db, box.project.id, 'Bob');
    enqueueMessage(box.db, box.project.id, 'web', 'box', { type: 'note', level: 'info', title: 'hello' });
    syncAs(box, SHARED);
    const c = side('c', 'client');
    syncAs(c, bob.token);
    expect(listNotifications(c.db, { all: true }).map((m) => m.title)).toEqual(['hello']);
    const d = side('d', 'client');
    syncAs(d, `${'a'.repeat(8)}.${'b'.repeat(64)}`);
    expect(listNotifications(d.db, { all: true })).toEqual([]);
    // and a shared-key client still reads it
    const e = side('e', 'client');
    syncAs(e, SHARED);
    expect(listNotifications(e.db, { all: true }).length).toBe(1);
  });
});
