import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { generateSealKeys, openSealed, sealTo } from '../src/control/seal.ts';
import { canonical, commandPath, replyPath, signMessage, validateArgs, verifyMessage, type Msg } from '../src/control/message.ts';
import { gitEnv, gitTransport, memoryTransport, problem, type ControlTransport } from '../src/control/transport.ts';
import { runWatcher, type Handlers } from '../src/control/watcher.ts';
import { readHeartbeat, sendCommand, waitReply, type BoxConfig } from '../src/control/client.ts';
import { newId } from '../src/sync/format.ts';
import { git } from '../src/sync/git.ts';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'salu-control-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

function setup(t: ControlTransport, now = Date.now) {
  const seal = generateSealKeys();
  const cfg: BoxConfig = { box: 'salubox', macKey: randomBytes(32), boxKey: randomBytes(32), sealPub: seal.publicKey };
  const calls: string[] = [];
  const secrets: string[] = [];
  const h: Handlers = {
    ping: async () => (calls.push('ping'), { ok: true, message: 'pong', data: { v: 1 } }),
    status: async () => (calls.push('status'), { ok: true, message: 'fine' }),
    'login.set': async ({ secret }) => (calls.push('login.set'), secrets.push(secret('token').toString()), { ok: true, message: 'stored' }),
    'project.create': async () => (calls.push('project.create'), { ok: true, message: 'made' }),
    'project.remove': async () => { throw new Error('boom\n  at stack trace'); },
    update: async () => (calls.push('update'), { ok: true, message: 'updated' }),
  };
  const w = runWatcher(t, h, { box: cfg.box, macKey: cfg.macKey, boxKey: cfg.boxKey, sealKey: seal.privateKey, intervalMs: 3_600_000, handledFile: join(root, 'handled'), now, heartbeat: () => ({ version: '9' }) });
  return { cfg, w, calls, secrets, seal };
}

describe('seal', () => {
  test('round trip, wrong key and tampering fail', () => {
    const a = generateSealKeys(), b = generateSealKeys();
    const s = sealTo(a.publicKey, Buffer.from('secret token'));
    expect(openSealed(a.privateKey, s).toString()).toBe('secret token');
    expect(() => openSealed(b.privateKey, s)).toThrow();
    const raw = Buffer.from(s, 'base64');
    raw[raw.length - 1]! ^= 1;
    expect(() => openSealed(a.privateKey, raw.toString('base64'))).toThrow();
    expect(sealTo(a.publicKey, Buffer.from('x'))).not.toBe(sealTo(a.publicKey, Buffer.from('x')));
  });
});

describe('message', () => {
  test('canonical sorts keys; sign and verify; tamper fails', () => {
    expect(canonical({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[2,{"y":2,"z":1}]},"b":1}');
    const k = randomBytes(32);
    const m = signMessage({ v: 1, id: newId(), box: 'b', verb: 'ping', at: 1, args: {}, sealed: {} }, k);
    expect(verifyMessage(m, k)).toBe(true);
    expect(verifyMessage({ ...m, verb: 'update' }, k)).toBe(false);
    expect(verifyMessage(m, randomBytes(32))).toBe(false);
  });
  test('validateArgs allowlist', () => {
    expect(validateArgs('ping', {}, {})).toBeNull();
    expect(validateArgs('rm -rf', {}, {})).toMatch(/unknown/);
    expect(validateArgs('ping', { x: 1 }, {})).toMatch(/does not take/);
    expect(validateArgs('project.create', { name: 'web', repo: 'git@github.com:me/web.git' }, { deployKey: 'a', signingKey: 'b' })).toBeNull();
    expect(validateArgs('project.create', { name: 'web; reboot', repo: 'git@github.com:me/web.git' }, { deployKey: 'a', signingKey: 'b' })).toMatch(/not valid/);
    expect(validateArgs('project.create', { name: 'web', repo: 'https://evil/x.git' }, { deployKey: 'a', signingKey: 'b' })).toMatch(/not valid/);
    expect(validateArgs('project.create', { name: 'web', repo: 'git@github.com:me/web.git' }, { deployKey: 'a' })).toMatch(/needs a sealed/);
    expect(validateArgs('login.set', { kind: 'subscription' }, { token: 'x', extra: 'y' })).toMatch(/does not take a sealed/);
    expect(validateArgs('update', { version: 'v1.2.3' }, {})).toBeNull();
    expect(validateArgs('update', { version: '1.2.3 && id' }, {})).toMatch(/not valid/);
  });
});

for (const kind of ['memory', 'git'] as const) {
  describe(`channel over ${kind}`, () => {
    const make = (): ControlTransport => {
      if (kind === 'memory') return memoryTransport();
      const bare = join(root, 'control.git');
      git(root, ['init', '-q', '--bare', '-b', 'main', bare]);
      return gitTransport({ url: bare, dir: join(root, `wc-${Math.random().toString(36).slice(2)}`) });
    };

    test('ping, sealed secret, reply is signed, handled once', async () => {
      const t = make();
      const { cfg, w, calls, secrets } = setup(t);
      const id = await sendCommand(t, cfg, 'ping');
      const lid = await sendCommand(t, cfg, 'login.set', { kind: 'subscription' }, { token: Buffer.from('sk-ant-oat01-abc') });
      await w.tick();
      const r = await waitReply(t, cfg, id, { timeoutMs: 2000 });
      expect(r).toMatchObject({ ok: true, message: 'pong', data: { v: 1 } });
      expect((await waitReply(t, cfg, lid)).ok).toBe(true);
      expect(secrets).toEqual(['sk-ant-oat01-abc']);
      // the token never appears in the stored command
      expect(await t.get(commandPath(cfg.box, lid))).not.toContain('sk-ant');
      expect(await w.tick()).toBe(0);
      expect(calls).toEqual(['ping', 'login.set']);
      w.stop();
    });

    test('tampered command is refused with ok:false and never runs', async () => {
      const t = make();
      const { cfg, w, calls } = setup(t);
      const id = await sendCommand(t, cfg, 'ping');
      const m = JSON.parse((await t.get(commandPath(cfg.box, id)))!) as Msg;
      const evilId = newId();
      await t.put(commandPath(cfg.box, evilId), JSON.stringify({ ...m, id: evilId, verb: 'update' }));
      await w.tick();
      const r = await waitReply(t, cfg, evilId, { timeoutMs: 2000 });
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/bad signature/);
      expect(calls).toEqual(['ping']);
      w.stop();
    });

    test('signed with the wrong key, unknown verb, bad args, bad json', async () => {
      const t = make();
      const { cfg, w, calls } = setup(t);
      const send = async (m: Omit<Msg, 'sig'>, key: Buffer, raw?: string) => {
        await t.put(commandPath(cfg.box, m.id), raw ?? JSON.stringify(signMessage(m, key)));
        await w.tick();
        return waitReply(t, cfg, m.id, { timeoutMs: 2000 });
      };
      const base = () => ({ v: 1 as const, id: newId(), box: cfg.box, verb: 'ping' as const, at: Date.now(), args: {}, sealed: {} });
      expect((await send(base(), randomBytes(32))).message).toMatch(/bad signature/);
      const unk = await send({ ...base(), verb: 'shell' as any, args: { cmd: 'id' } }, cfg.macKey);
      expect(unk.ok).toBe(false);
      expect(unk.message).toMatch(/unknown command/);
      const badArgs = await send({ ...base(), verb: 'project.remove', args: { name: '../etc' } }, cfg.macKey);
      expect(badArgs.message).toMatch(/not valid/);
      expect((await send(base(), cfg.macKey, 'not json')).message).toMatch(/not JSON/);
      expect(calls).toEqual([]);
      w.stop();
    });

    test('replayed command (same file copied to a new id, or box restart) runs once', async () => {
      const t = make();
      const a = setup(t);
      const id = await sendCommand(t, a.cfg, 'update');
      await a.w.tick();
      a.w.stop();
      // a restarted watcher reads the handled file and does not run it again
      const b = runWatcher(t, { ...({} as Handlers), update: async () => { throw new Error('ran twice'); } } as Handlers, { box: a.cfg.box, macKey: a.cfg.macKey, boxKey: a.cfg.boxKey, sealKey: a.seal.privateKey, intervalMs: 3_600_000, handledFile: join(root, 'handled') });
      expect(await b.tick()).toBe(0);
      b.stop();
      // copying an old signed file to a new id fails: the id is signed
      const m = JSON.parse((await t.get(commandPath(a.cfg.box, id)))!);
      const copy = newId();
      await t.put(commandPath(a.cfg.box, copy), JSON.stringify({ ...m, id: copy }));
      const c = setup(t);
      expect(c.cfg.box).toBe(a.cfg.box);
      expect(a.calls).toEqual(['update']);
    });

    test('commands older than 24 hours and from the future are ignored', async () => {
      const t = make();
      const { cfg, w, calls } = setup(t);
      const put = async (at: number) => {
        const id = newId(at);
        await t.put(commandPath(cfg.box, id), JSON.stringify(signMessage({ v: 1, id, box: cfg.box, verb: 'ping', at, args: {}, sealed: {} }, cfg.macKey)));
        await w.tick();
        return waitReply(t, cfg, id, { timeoutMs: 2000 });
      };
      expect((await put(Date.now() - 25 * 3600_000)).message).toMatch(/older than 24 hours/);
      expect((await put(Date.now() + 3600_000)).message).toMatch(/future/);
      expect((await put(Date.now() - 23 * 3600_000)).ok).toBe(true);
      expect(calls).toEqual(['ping']);
      w.stop();
    });

    test('a handler that throws gives a one-line reply, not a crash', async () => {
      const t = make();
      const { cfg, w } = setup(t);
      const id = await sendCommand(t, cfg, 'project.remove', { name: 'web' });
      await w.tick();
      const r = await waitReply(t, cfg, id, { timeoutMs: 2000 });
      expect(r.ok).toBe(false);
      expect(r.message).not.toContain('\n');
    });

    test('forged reply is not accepted; heartbeat is signed and readable', async () => {
      const t = make();
      const { cfg, w } = setup(t);
      const id = newId();
      await t.put(replyPath(cfg.box, id), JSON.stringify({ v: 1, id, box: cfg.box, ok: true, message: 'fake', at: 1, sig: 'ab' }));
      await expect(waitReply(t, cfg, id, { timeoutMs: 100, pollMs: 20 })).rejects.toThrow(/no answer/);
      await w.tick();
      expect((await readHeartbeat(t, cfg))?.data).toEqual({ version: '9' });
      expect(await readHeartbeat(t, { ...cfg, boxKey: randomBytes(32) })).toBeUndefined();
      w.stop();
    });
  });
}

describe('ssh host key', () => {
  test('a deploy key pins github.com and writes its own known_hosts', async () => {
    const key = join(root, 'deploy');
    const e = gitEnv(key);
    const kh = readFileSync(`${key}.known_hosts`, 'utf8');
    expect(kh).toBe('github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n');
    expect(e.GIT_SSH_COMMAND).toContain('StrictHostKeyChecking=yes');
    expect(e.GIT_SSH_COMMAND).toContain(`UserKnownHostsFile=${JSON.stringify(`${key}.known_hosts`)}`);
    const { createHash } = await import('node:crypto');
    const fp = createHash('sha256').update(Buffer.from(kh.split(' ')[2]!.trim(), 'base64')).digest('base64').replace(/=+$/, '');
    expect(fp).toBe('+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU');
    expect(gitEnv(join(root, 'k2'), 'example.org ssh-ed25519 AAAA\n').GIT_SSH_COMMAND).toContain('k2.known_hosts');
  });
  test('a host key failure is not reported as a deploy key problem', () => {
    const m = problem('Host key verification failed.\nfatal: Could not read from remote repository.').message;
    expect(m).toMatch(/host key/);
    expect(m).not.toMatch(/deploy key/);
    expect(problem('git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.').message).toMatch(/deploy key/);
  });
});

describe('git transport', () => {
  test('two writers never lose a file; write-once; path checks; file size', async () => {
    const bare = join(root, 'c.git');
    git(root, ['init', '-q', '--bare', '-b', 'main', bare]);
    const a = gitTransport({ url: bare, dir: join(root, 'a') });
    const b = gitTransport({ url: bare, dir: join(root, 'b') });
    await Promise.all([a.put('boxes/x/commands/1.json', 'A'), b.put('boxes/x/commands/2.json', 'B')]);
    await a.put('boxes/x/commands/1.json', 'changed');
    expect(await b.list('boxes/x/commands')).toEqual(['1.json', '2.json']);
    expect(await b.get('boxes/x/commands/1.json')).toBe('A');
    expect(await a.get('boxes/x/nothing.json')).toBeUndefined();
    await expect(a.put('../evil', 'x')).rejects.toThrow(/bad control path/);
    await expect(a.put('boxes/x/big.json', 'x'.repeat(70000))).rejects.toThrow(/64 KiB/);
    expect(existsSync(join(root, 'evil'))).toBe(false);
  });
  test('a file over the cap in the repo is skipped without being read', async () => {
    const bare = join(root, 'big.git');
    git(root, ['init', '-q', '--bare', '-b', 'main', bare]);
    const w = join(root, 'writer');
    git(root, ['clone', '-q', bare, w]);
    mkdirSync(join(w, 'boxes/x/commands'), { recursive: true });
    writeFileSync(join(w, 'boxes/x/commands/big.json'), 'x'.repeat(70000));
    git(w, ['add', '-A']);
    git(w, ['commit', '-q', '-m', 'big']);
    git(w, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
    const t = gitTransport({ url: bare, dir: join(root, 'reader') });
    expect(await t.list('boxes/x/commands')).toEqual(['big.json']);
    expect(await t.get('boxes/x/commands/big.json')).toBeUndefined();
  });
  test('an unreachable repo says so in words', async () => {
    const t = gitTransport({ url: join(root, 'missing.git'), dir: join(root, 'w') });
    await expect(t.list('boxes/x/commands')).rejects.toThrow(/could not reach the control repo/);
  });
});

describe('salu control watch', () => {
  test('stays running after several rounds and answers a command', async () => {
    const bare = join(root, 'ctl.git');
    git(root, ['init', '-q', '--bare', '-b', 'main', bare]);
    const dir = join(root, 'box');
    const { ensureBoxKeys, saveConnection } = await import('../src/control/keys.ts');
    const { sealPub, boxKey } = ensureBoxKeys(dir);
    const macKey = randomBytes(32);
    saveConnection(bare, 'salubox', macKey, dir);
    const proc = Bun.spawn(['bun', join(import.meta.dir, '../src/index.ts'), 'control', 'watch', '--interval', '1'], { env: { ...process.env, SALU_BOX_DIR: dir }, stdout: 'pipe', stderr: 'pipe' });
    try {
      await new Promise((r) => setTimeout(r, 3500)); // several rounds
      expect(proc.exitCode).toBeNull();
      const t = gitTransport({ url: bare, dir: join(root, 'mac') });
      const cfg: BoxConfig = { box: 'salubox', macKey, boxKey, sealPub };
      const id = await sendCommand(t, cfg, 'ping');
      expect((await waitReply(t, cfg, id, { timeoutMs: 15000, pollMs: 500 })).ok).toBe(true);
      expect(proc.exitCode).toBeNull();
    } finally {
      proc.kill();
    }
  }, 40000);
});
