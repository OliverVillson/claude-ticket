import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../src/db/db.ts';
import { claimNextTicket, createProject, listTickets, updateTicket } from '../src/db/queries.ts';
import { setRemote } from '../src/sync/store.ts';
import { syncProject } from '../src/sync/sync.ts';
import { recordRemoteEvent } from '../src/sync/events.ts';
import { git } from '../src/sync/git.ts';

/*
 * The iPhone app (ios/SaluPhone) talks to the box through the GitHub contents API: each file it sends
 * is one commit on salu/inbox made by GitHub, and it reads salu-inbox/messages the same way. This test
 * writes files exactly the way the app builds them (Models.swift + Signing.swift: JSONEncoder, then
 * `sig` over the canonical JSON) as separate commits, runs the box's sync, and reads the answers the
 * way the app decodes them (SaluMessage's required fields).
 */

const KEY = 'a'.repeat(32) + 'b'.repeat(32); // what `salu remote key` shows: 64 hex
let root: string;
let bare: string;
let box: { db: ReturnType<typeof openDb>; project: ReturnType<typeof createProject>; sync: string };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'salu-phone-'));
  process.env.SALU_HOME = join(root, 'home');
  process.env.SALU_REMOTE_KEY = KEY;
  delete process.env.SALU_REMOTE_ALLOW_UNSIGNED;
  bare = join(root, 'remote.git');
  git(root, ['init', '-q', '--bare', bare]);
  const db = openDb(join(root, 'box.db'));
  const path = join(root, 'box-web');
  git(root, ['init', '-q', path]);
  const project = createProject(db, { name: 'e2e-first', path });
  setRemote(db, { project_id: project.id, url: bare, role: 'box', name: 'box' });
  box = { db, project, sync: join(root, 'box-sync') };
});
afterEach(() => {
  box.db.close();
  delete process.env.SALU_SYNC_DIR;
  delete process.env.SALU_HOME;
  delete process.env.SALU_REMOTE_KEY;
  rmSync(root, { recursive: true, force: true });
});

const syncBox = () => {
  process.env.SALU_SYNC_DIR = box.sync;
  return syncProject(box.db, box.project);
};

// --- the phone, as Signing.swift does it -------------------------------------------------------

/** Signing.canonical: keys sorted by UTF-16 units, compact, integral numbers without a fraction. */
function phoneCanonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(phoneCanonical).join(',')}]`;
  if (v === null) return 'null';
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => k !== 'sig').sort().map((k) => `${JSON.stringify(k)}:${phoneCanonical(o[k])}`).join(',')}}`;
  }
  if (typeof v === 'number') return String(v); // the app only sends integers (ids, times, priorities)
  return JSON.stringify(v);
}
/** Signing.encode: the encoded value plus `sig`, written compact (JSONSerialization). */
function phoneEncode(o: Record<string, unknown>): string {
  const sig = createHmac('sha256', KEY.trim()).update(phoneCanonical(o)).digest('hex');
  return JSON.stringify({ ...o, sig });
}
/** Signing.verify */
function phoneVerify(text: string): boolean {
  const o = JSON.parse(text);
  return typeof o.sig === 'string' && createHmac('sha256', KEY).update(phoneCanonical(o)).digest('hex') === o.sig;
}
let last = 0;
/** newTicketId(): `<13-digit ms>-<8 hex>` */
function phoneId(): string {
  last = Math.max(Date.now(), last + 1);
  return `${String(last).padStart(13, '0')}-${Math.floor(Math.random() * 2 ** 32).toString(16).padStart(8, '0')}`;
}
/** One contents API PUT: GitHub makes a commit with just that file on salu/inbox. */
function phonePut(path: string, text: string): void {
  const dir = join(root, 'phone');
  rmSync(dir, { recursive: true, force: true });
  const c = git(root, ['clone', '-q', '--branch', 'salu/inbox', bare, dir]);
  expect(c.ok).toBe(true);
  mkdirSync(join(dir, path, '..'), { recursive: true });
  writeFileSync(join(dir, path), text);
  git(dir, ['add', path]);
  expect(git(dir, ['-c', 'user.name=GitHub', '-c', 'user.email=noreply@github.com', 'commit', '-qm', `salu ${path}`]).ok).toBe(true);
  expect(git(dir, ['push', '-q', 'origin', 'HEAD:refs/heads/salu/inbox']).ok).toBe(true);
}
/** GitHubClient.messages: list salu-inbox/messages, keep the signed files that decode as SaluMessage. */
function phoneMessages(): any[] {
  const dir = join(root, 'phone-read');
  rmSync(dir, { recursive: true, force: true });
  git(root, ['clone', '-q', '--branch', 'salu/inbox', bare, dir]);
  const d = join(dir, 'salu-inbox', 'messages');
  const out: any[] = [];
  for (const name of readdirSync(d).filter((n) => n.endsWith('.json'))) {
    const text = readFileSync(join(d, name), 'utf8');
    expect(phoneVerify(text)).toBe(true);
    const m = JSON.parse(text);
    // SaluMessage's non-optional fields, with their Swift types
    expect(m.v).toBe(1);
    for (const k of ['id', 'project', 'from', 'type', 'level', 'title']) expect(typeof m[k]).toBe('string');
    expect(typeof m.at).toBe('number');
    if (m.ticket) {
      expect(typeof m.ticket.name).toBe('string');
      expect(Number.isInteger(m.ticket.id)).toBe(true);
    }
    out.push(m);
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

describe('the iPhone app and the box', () => {
  test('a ticket from the phone reaches the box, is acknowledged, and the answer reads on the phone', () => {
    syncBox(); // the box made salu/inbox when the project was set up
    const id = phoneId();
    const at = Number(id.slice(0, 13));
    // Store.send -> SaluTicket(id:project:name:query:priority:queue:at:) with tags [:] and labels []
    phonePut(`salu-inbox/tickets/${id}.json`, phoneEncode({ v: 1, id, project: 'e2e-first', name: 'add dark mode', query: 'Add a dark mode toggle', tags: {}, labels: [], priority: 2, queue: true, at }));

    const s = syncBox();
    expect(s.ticketsReceived).toBe(1);
    const onBox = listTickets(box.db)[0]!;
    expect(onBox.name).toBe('add dark mode');
    expect(onBox.status).toBe('todo');
    expect(onBox.priority).toBe(2);

    const ack = phoneMessages().find((m) => m.type === 'ticket.accepted')!;
    expect(ack.ticket.ref).toBe(id); // joins the box's ticket to the phone's (Tickets.build)
    expect(ack.ticket.id).toBe(onBox.id);
    expect(ack.title).toContain('queued to run');

    // it runs and finishes; the phone sees started and done with the worker's reply
    const running = claimNextTicket(box.db)!;
    recordRemoteEvent(box.db, { type: 'dispatch', ticket: running, runId: 1, resumed: false });
    const done = updateTicket(box.db, running.id, { status: 'done' });
    recordRemoteEvent(box.db, { type: 'finish', ticket: done, outcome: 'done', costUsd: 0, turns: 2, status: 'done' });
    syncBox();
    expect(phoneMessages().map((m) => m.type)).toEqual(['ticket.accepted', 'ticket.started', 'ticket.done']);

    // keep chatting: Store.reply -> SaluReply with flat ref/name and the nested ticket
    const rid = phoneId();
    phonePut(`salu-inbox/replies/${rid}.json`, phoneEncode({ v: 1, id: rid, project: 'e2e-first', ref: id, name: 'add dark mode', ticket: { ref: id, id: onBox.id, name: 'add dark mode' }, body: 'Also remember the choice', now: false, at: Number(rid.slice(0, 13)) }));
    expect(syncBox().repliesReceived).toBe(1);
    expect(listTickets(box.db)[0]!.status).toBe('todo');
    const answers = phoneMessages().filter((m) => m.id > rid);
    expect(answers.map((m) => m.type)).toEqual(['ticket.accepted']); // SentReply.answered(by:)
  });

  test('a ticket the phone saves for later lands in the backlog', () => {
    syncBox();
    const id = phoneId();
    phonePut(`salu-inbox/tickets/${id}.json`, phoneEncode({ v: 1, id, project: 'e2e-first', name: 'later', query: 'Some idea', tags: {}, labels: [], priority: 3, queue: false, at: Number(id.slice(0, 13)) }));
    syncBox();
    expect(listTickets(box.db)[0]!.status).toBe('backlog');
  });

  test('a file signed with another key is ignored by the box', () => {
    syncBox();
    const id = phoneId();
    const o = { v: 1, id, project: 'e2e-first', name: 'forged', query: 'x', tags: {}, labels: [], priority: 3, queue: true, at: 1 };
    phonePut(`salu-inbox/tickets/${id}.json`, JSON.stringify({ ...o, sig: createHmac('sha256', 'wrong key, 16+ chars').update(phoneCanonical(o)).digest('hex') }));
    expect(syncBox().ticketsReceived).toBe(0);
    expect(listTickets(box.db).length).toBe(0);
  });
});
