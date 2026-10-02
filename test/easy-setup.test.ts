/**
 * Easy setup, end to end, with no ssh and no gh: a fake box and a Mac in one process talk through a local bare
 * repo (see test/easy-setup/fake-box.ts). Covers pairing, login.set, project.create and a ticket round trip,
 * plus the contract's safety rules. Runs against src/control/ when it exists, else the reference in
 * test/easy-setup/ref-control.ts (the first test says which).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/db.ts';
import { claimNextTicket, createProject, createTicket, getTicketById, listTickets, updateTicket } from '../src/db/queries.ts';
import { listNotifications, setRemote } from '../src/sync/store.ts';
import { publishTicket, syncProject } from '../src/sync/sync.ts';
import { recordRemoteEvent } from '../src/sync/events.ts';
import { generateKey, signFile } from '../src/sync/format.ts';
import { git } from '../src/sync/git.ts';
import { control, realHandlers, usingRealControl } from './easy-setup/control.ts';
import { BOX, fakeBox, type FakeBox } from './easy-setup/fake-box.ts';

let fb: FakeBox;
beforeEach(async () => {
  fb = await fakeBox();
});
afterEach(() => fb.cleanup());

/** Everything ever committed to the control repo, as one string (working tree of every commit). */
function everythingInControlRepo(): string {
  const dir = join(fb.root, 'audit');
  git(fb.root, ['clone', '-q', fb.controlRepo, dir]);
  return git(dir, ['log', '-p', '--all', '--no-color']).out;
}

describe('pairing and the command round trip', () => {
  test('which control channel is under test', () => {
    console.log(usingRealControl ? 'control channel: real src/control/' : 'control channel: reference (src/control/ not there yet)');
    expect(typeof control.sendCommand).toBe('function');
  });

  test('ping is answered, signed by the box', async () => {
    const r = await fb.send('ping');
    expect(r.ok).toBe(true);
    expect(r.box).toBe(BOX);
    expect(control.verifyMessage(r, fb.cfg.boxKey)).toBe(true);
    expect(control.verifyMessage(r, fb.cfg.macKey)).toBe(false);
  });

  test('status comes back as a line a person can read', async () => {
    const r = await fb.send('status');
    expect(r.ok).toBe(true);
    expect(r.message.length).toBeGreaterThan(0);
    expect(r.message).not.toMatch(/\bat \S+\.ts:\d+/); // no stack traces
  });

  test('files follow the layout of the contract', async () => {
    const r = await fb.send('ping');
    const audit = join(fb.root, 'audit');
    git(fb.root, ['clone', '-q', fb.controlRepo, audit]);
    expect(readdirSync(join(audit, 'boxes', BOX, 'commands')).length).toBe(1);
    expect(readdirSync(join(audit, 'boxes', BOX, 'replies'))).toEqual([`${r.id}.json`]);
  });
});

describe('login.set', () => {
  const token = 'sk-ant-oat01-' + 'T'.repeat(60);
  test('the token reaches the box and never appears in the control repo', async () => {
    const r = await fb.send('login.set', { kind: 'subscription' }, { token: Buffer.from(token) });
    expect(r.ok).toBe(true);
    expect(fb.calls.at(-1)!.secrets.token).toBe(token);
    const all = everythingInControlRepo();
    expect(all).not.toContain(token);
    expect(all).not.toContain(Buffer.from(token).toString('base64'));
    expect(all).toContain('"sealed"');
  });

  test('only the box can open a sealed field', () => {
    const wrong = control.newSealKeys ? (control as any).newSealKeys() : null;
    const sealed = control.sealTo(fb.cfg.sealPub, Buffer.from('secret'));
    if (wrong) expect(() => control.openSealed(wrong.priv, sealed)).toThrow();
  });

  test('a sealed field cannot be swapped or changed without the signature failing', async () => {
    const id = await control.sendCommand(fb.mac, fb.cfg, 'login.set', { kind: 'subscription' }, { token: Buffer.from('a') });
    const ok = await control.waitReply(fb.mac, fb.cfg, id);
    expect(ok.ok).toBe(true);
    // Rewrite the same command with another sealed value, keeping the old signature, under a new id.
    const text = await fb.mac.get(`boxes/${BOX}/commands/${id}.json`);
    const m = JSON.parse(text!);
    const id2 = id.slice(0, -8) + 'deadbeef';
    m.id = id2;
    m.sealed.token = control.sealTo(fb.cfg.sealPub, Buffer.from('attacker'));
    await fb.mac.put(`boxes/${BOX}/commands/${id2}.json`, JSON.stringify(m));
    const r = await control.waitReply(fb.mac, fb.cfg, id2);
    expect(r.ok).toBe(false);
    expect(fb.calls.filter((c) => c.verb === 'login.set').length).toBe(1);
  });
});

describe('what the box refuses', () => {
  const raw = async (m: object, id: string) => fb.mac.put(`boxes/${BOX}/commands/${id}.json`, JSON.stringify(m));
  const base = (id: string, extra: object = {}) => ({ v: 1, id, box: BOX, verb: 'ping', at: Date.now(), args: {}, sealed: {}, ...extra });
  const mkId = (n: number) => `${String(1759413000000 + n)}-0000000${n}`;

  test('a command signed with the wrong key gets ok:false and runs nothing', async () => {
    const id = mkId(1);
    await raw(control.signMessage(base(id, { verb: 'login.set', args: { kind: 'subscription' } }) as any, Buffer.alloc(32, 7)), id);
    const r = await control.waitReply(fb.mac, fb.cfg, id);
    expect(r.ok).toBe(false);
    expect(fb.calls.length).toBe(0);
  });

  test('an unknown verb gets ok:false, not a crash, and the next command still works', async () => {
    const id = mkId(2);
    await raw(control.signMessage(base(id, { verb: 'shell' }) as any, fb.cfg.macKey), id);
    const r = await control.waitReply(fb.mac, fb.cfg, id);
    expect(r.ok).toBe(false);
    expect((await fb.send('ping')).ok).toBe(true);
  });

  test('a command older than 24 h is ignored', async () => {
    const id = mkId(3);
    await raw(control.signMessage(base(id, { at: Date.now() - 25 * 3600 * 1000 }) as any, fb.cfg.macKey), id);
    // Ignored (no answer) or refused (ok:false); either way nothing runs.
    const r = await control.waitReply(fb.mac, fb.cfg, id, { timeoutMs: 1500 }).catch(() => null);
    expect(r?.ok ?? false).toBe(false);
    expect(fb.calls.length).toBe(0);
  });

  test('a command for another box is not run', async () => {
    const id = mkId(4);
    await raw(control.signMessage(base(id, { box: 'other' }) as any, fb.cfg.macKey), id);
    const r = await control.waitReply(fb.mac, fb.cfg, id);
    expect(r.ok).toBe(false);
    expect(fb.calls.length).toBe(0);
  });

  test('a repeated id runs once (replay)', async () => {
    fb.stop();
    const handledFile = join(fb.boxHome, 'handled');
    const mk = (calls: any[]) => (control as any).runWatcher(control.gitTransport({ url: fb.controlRepo, dir: join(fb.boxHome, 'control2') }), {
      ping: async () => (calls.push(1), { ok: true, message: 'pong' }),
    }, { box: BOX, macKey: fb.cfg.macKey, boxKey: fb.cfg.boxKey, sealKey: Buffer.alloc(32), intervalMs: 50, handledFile, onError: () => {} });
    const calls: any[] = [];
    const w = mk(calls);
    const id = await control.sendCommand(fb.mac, fb.cfg, 'ping', {});
    await control.waitReply(fb.mac, fb.cfg, id);
    w.stop();
    // A restarted watcher that remembers the handled ids must not answer again.
    const w2 = mk(calls);
    await new Promise((r) => setTimeout(r, 400));
    w2.stop();
    expect(calls.length).toBe(1);
  });

  test('a reply that was not signed by the box is rejected by the Mac', async () => {
    const id = mkId(5);
    const forged = control.signMessage({ v: 1, id, box: BOX, ok: true, message: 'fine', at: Date.now() } as any, Buffer.alloc(32, 9));
    await fb.mac.put(`boxes/${BOX}/replies/${id}.json`, JSON.stringify(forged));
    await expect(control.waitReply(fb.mac, fb.cfg, id, { timeoutMs: 1500 })).rejects.toThrow();
  });

  test('a file over 64 KiB is refused by the transport', async () => {
    await expect(fb.mac.put(`boxes/${BOX}/commands/big.json`, 'x'.repeat(70000))).rejects.toThrow();
  });
});

describe('project.create and a ticket round trip', () => {
  test('a new project: secrets arrive sealed, bad names are refused', async () => {
    const repo = fb.newProjectRepo('web');
    const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA' + 'k'.repeat(40) + '\n-----END OPENSSH PRIVATE KEY-----\n';
    const signing = generateKey();
    const r = await fb.send('project.create', { name: 'web', repo: 'git@github.com:test/web.git' }, { deployKey: Buffer.from(key), signingKey: Buffer.from(signing) });
    expect(r.ok).toBe(true);
    expect(fb.calls.at(-1)!.secrets.signingKey).toBe(signing);
    expect(everythingInControlRepo()).not.toContain(signing);
    expect(everythingInControlRepo()).not.toContain('AAAA' + 'k'.repeat(40));

    // The Mac refuses to send it; a hand-made signed command is refused by the box.
    const evil = { name: 'Web; rm -rf /', repo: 'git@github.com:a/b.git' };
    await expect(fb.send('project.create', evil, { deployKey: Buffer.from('x'), signingKey: Buffer.from('y') })).rejects.toThrow();
    const id = '1759413000000-0000000a';
    await fb.mac.put(`boxes/${BOX}/commands/${id}.json`, JSON.stringify(control.signMessage({ v: 1, id, box: BOX, verb: 'project.create', at: Date.now(), args: evil, sealed: {} } as any, fb.cfg.macKey)));
    const bad = await control.waitReply(fb.mac, fb.cfg, id);
    expect(bad.ok).toBe(false);
    expect(bad.message.length).toBeGreaterThan(0);
    expect(fb.calls.filter((c) => c.verb === 'project.create').length).toBe(1);
  });

  test('a ticket added on the Mac runs on the box and the result comes back', async () => {
    const root = mkdtempSync(join(tmpdir(), 'salu-e2e-'));
    const keep = { home: process.env.SALU_HOME, unsigned: process.env.SALU_REMOTE_ALLOW_UNSIGNED, dir: process.env.SALU_SYNC_DIR, key: process.env.SALU_REMOTE_KEY };
    try {
      process.env.SALU_HOME = join(root, 'home');
      delete process.env.SALU_REMOTE_ALLOW_UNSIGNED;
      const repo = fb.newProjectRepo('web');
      const signing = generateKey();
      process.env.SALU_REMOTE_KEY = signing; // both sides hold the signing key the Mac sent sealed
      const r = await fb.send('project.create', { name: 'web', repo: 'git@github.com:test/web.git' }, { deployKey: Buffer.from('k'), signingKey: Buffer.from(signing) });
      expect(r.ok).toBe(true);

      // What the real handler does on the box, and `salu new` on the Mac: a project each, joined by the repo.
      const mk = (name: string, role: 'client' | 'box') => {
        const db = openDb(join(root, `${name}.db`));
        const path = join(root, `${name}-web`);
        git(root, ['init', '-q', path]);
        const project = createProject(db, { name: 'web', path });
        setRemote(db, { project_id: project.id, url: repo, role, name });
        return { db, project, sync: join(root, `${name}-sync`) };
      };
      const mac = mk('mac', 'client');
      const box = mk('box', 'box');
      const sync = (s: typeof mac) => ((process.env.SALU_SYNC_DIR = s.sync), syncProject(s.db, s.project));

      const t = createTicket(mac.db, { project_id: mac.project.id, name: 'first', query: 'say hi', status: 'todo' });
      publishTicket(mac.db, mac.project, t, { queue: true });
      expect(sync(mac).ticketsSent).toBe(1);
      expect(sync(box).ticketsReceived).toBe(1);
      const running = claimNextTicket(box.db)!;
      expect(listTickets(box.db)[0]!.name).toBe('first');
      recordRemoteEvent(box.db, { type: 'dispatch', ticket: running, runId: 1, resumed: false });
      const done = updateTicket(box.db, running.id, { status: 'done' });
      recordRemoteEvent(box.db, { type: 'finish', ticket: done, outcome: 'done', costUsd: 0, turns: 1, status: 'done' });
      sync(box);
      sync(mac);
      expect(getTicketById(mac.db, t.id)!.status).toBe('done');
      expect(listNotifications(mac.db).map((n) => n.type)).toContain('ticket.done');
      mac.db.close();
      box.db.close();
    } finally {
      for (const [k, v] of [['SALU_HOME', keep.home], ['SALU_REMOTE_ALLOW_UNSIGNED', keep.unsigned], ['SALU_SYNC_DIR', keep.dir], ['SALU_REMOTE_KEY', keep.key]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// The real verb handlers (piece 3). These start working the moment src/box/handlers exists.
const real = await realHandlers();
describe.skipIf(!real)('real box handlers', () => {
  test('placeholder: wire handlers into fakeBox({ handlers }) when piece 3 lands', () => {
    expect(real).toBeTruthy();
  });
});
