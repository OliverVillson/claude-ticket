import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHandlers } from '../src/box/handlers/index.ts';
import type { BoxDeps } from '../src/box/handlers/types.ts';
import { boxLoginEnvFile, boxLoginFile, readBoxLogin } from '../src/box/login.ts';
import { GITHUB_HOST_KEY, gitSshCommand } from '../src/box/hosts.ts';
import { canonicalJson, heartbeatBody } from '../src/box/heartbeat.ts';

let d: string;
const saved = process.env.SALU_RUNNER_ROOT;
beforeEach(() => {
  d = mkdtempSync(join(tmpdir(), 'salu-boxh-'));
  process.env.SALU_RUNNER_ROOT = join(d, 'var');
  mkdirSync(process.env.SALU_RUNNER_ROOT, { recursive: true });
});
afterEach(() => {
  if (saved === undefined) delete process.env.SALU_RUNNER_ROOT;
  else process.env.SALU_RUNNER_ROOT = saved;
});

/** Fake deps: records every command; `reply` decides each result. */
function fake(reply: (cmd: string[]) => { ok: boolean; out: string } = () => ({ ok: true, out: '' })) {
  const calls: Array<{ cmd: string[]; as?: string; env?: Record<string, string>; seen?: Record<string, string> }> = [];
  const deps: BoxDeps = {
    salu: '/usr/local/bin/salu',
    user: 'salu',
    version: '1.2.0',
    tmpDir: join(d, 'tmp'),
    now: () => 1_759_413_000_000,
    run: async (cmd, o) => {
      // read the secret files while they exist, to prove their contents and modes
      const seen: Record<string, string> = {};
      for (const a of cmd) if (a.startsWith(join(d, 'tmp')) && existsSync(a)) seen[a] = `${readFileSync(a, 'utf8')}|${(statSync(a).mode & 0o777).toString(8)}`;
      calls.push({ cmd, as: o?.as, env: o?.env, seen });
      return reply(cmd);
    },
  };
  return { deps, calls, handlers: createHandlers(deps) };
}
const secrets = (m: Record<string, string>) => ({ args: undefined as any, secret: (f: string) => (m[f] === undefined ? (() => { throw new Error('no ' + f); })() : Buffer.from(m[f]!)) });
const call = (h: any, args: any, sec: Record<string, string> = {}) => h({ args, secret: secrets(sec).secret });

describe('login.set', () => {
  test('saves ONE login: the kernel token file and the env file every runner unit reads, both private', async () => {
    const f = fake();
    const r = await call(f.handlers['login.set'], { kind: 'subscription' }, { token: 'sk-ant-oat01-abc123\n' });
    expect(r.ok).toBe(true);
    expect(readBoxLogin()).toBe('sk-ant-oat01-abc123');
    expect(readFileSync(boxLoginEnvFile(), 'utf8')).toBe('CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-abc123\n');
    for (const file of [boxLoginFile(), boxLoginEnvFile()]) expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(r)).not.toContain('abc123'); // the token is never in the reply
    expect(JSON.stringify(f.calls)).not.toContain('abc123'); // nor on a command line
  });

  test('restarts idle projects only and names the busy ones', async () => {
    const list = JSON.stringify([
      { project: 'idle', service: 'active', sync: 'active', todo: 0, running: 0, blocked: 0, done: 1 },
      { project: 'busy', service: 'active', sync: 'active', todo: 0, running: 2, blocked: 0, done: 0 },
    ]);
    const f = fake((c) => (c[2] === 'list' ? { ok: true, out: list } : { ok: true, out: '' }));
    const r = await call(f.handlers['login.set'], { kind: 'subscription' }, { token: 'sk-ant-oat01-abc123' });
    expect(f.calls.map((c) => c.cmd.slice(1).join(' '))).toEqual(['runner list --json', 'runner restart idle']);
    expect(r.message).toContain('busy');
    expect(r.data).toEqual({ restarted: ['idle'], busy: ['busy'] });
  });

  test('refuses a wrong kind, a missing token and a token that is not one', async () => {
    const f = fake();
    expect((await call(f.handlers['login.set'], { kind: 'api-key' }, { token: 'sk-ant-oat01-abc123' })).ok).toBe(false);
    expect((await call(f.handlers['login.set'], { kind: 'subscription' })).message).toContain('no token');
    expect((await call(f.handlers['login.set'], { kind: 'subscription' }, { token: 'x y; rm -rf /' })).ok).toBe(false);
    expect(readBoxLogin()).toBeNull();
  });
});

describe('project.create', () => {
  const args = { name: 'playground', repo: 'git@github.com:me/playground.git' };
  const keys = { deployKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nAAA\n-----END OPENSSH PRIVATE KEY-----', signingKey: 'a'.repeat(64) };

  test('is one runner add with the keys as private files, removed afterwards, and the user as env', async () => {
    const f = fake((c) => (c[2] === 'list' ? { ok: true, out: 'no runner projects yet' } : { ok: true, out: '' }));
    const r = await call(f.handlers['project.create'], { ...args, concurrency: 2 }, keys);
    expect(r.ok).toBe(true);
    const add = f.calls.find((c) => c.cmd[2] === 'add')!;
    expect(add.cmd.slice(0, 6)).toEqual(['/usr/local/bin/salu', 'runner', 'add', 'playground', '--clone', 'git@github.com:me/playground.git']);
    expect(add.cmd).toContain('--concurrency');
    expect(add.cmd).not.toContain('--token-file'); // the box login is used
    const [deployPath, signPath] = [add.cmd[add.cmd.indexOf('--deploy-key-file') + 1]!, add.cmd[add.cmd.indexOf('--signing-key-file') + 1]!];
    expect(add.seen![deployPath]).toContain('BEGIN OPENSSH PRIVATE KEY');
    expect(add.seen![deployPath]!.endsWith('|600')).toBe(true);
    expect(add.seen![signPath]).toBe(`${keys.signingKey}|600`);
    expect(existsSync(deployPath)).toBe(false); // gone once the command ended
    expect(readdirSync(join(d, 'tmp'))).toEqual([]);
    expect(add.env).toEqual({ SALU_RUNNER_USER: 'salu' });
    expect(JSON.stringify(r)).not.toContain(keys.signingKey);
  });

  test('refuses bad names, bad repos (no shell strings, no https), bad concurrency and missing keys, without running anything', async () => {
    const f = fake();
    for (const a of [{ ...args, name: 'Bad Name' }, { ...args, name: '../x' }, { ...args, repo: 'https://github.com/me/p.git' }, { ...args, repo: 'git@github.com:me/p.git; rm -rf /' }, { ...args, concurrency: 99 }]) {
      expect((await call(f.handlers['project.create'], a, keys)).ok).toBe(false);
    }
    expect((await call(f.handlers['project.create'], args, { deployKey: 'x' })).message).toContain('keys');
    expect(f.calls).toEqual([]);
  });

  test('a project that already exists is a success that changes nothing (a repeated command is harmless)', async () => {
    const list = JSON.stringify([{ project: 'playground', service: 'active', sync: 'active', todo: 0, running: 0, blocked: 0, done: 0 }]);
    const f = fake(() => ({ ok: true, out: list }));
    const r = await call(f.handlers['project.create'], args, keys);
    expect(r.ok).toBe(true);
    expect(f.calls.some((c) => c.cmd[2] === 'add')).toBe(false);
  });

  test('a clone that is refused says what to do, in words', async () => {
    const f = fake((c) => (c[2] === 'add' ? { ok: false, out: 'could not register the project:\ngit@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.' } : { ok: true, out: '' }));
    const r = await call(f.handlers['project.create'], args, keys);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('deploy key');
    expect(r.message).not.toContain('\n');
    expect(readdirSync(join(d, 'tmp'))).toEqual([]); // keys removed on failure too
  });
});

describe('project.remove', () => {
  test('stops the project; purge deletes its data; an unknown project is fine', async () => {
    const list = JSON.stringify([{ project: 'web', service: 'active', sync: null, todo: 0, running: 0, blocked: 0, done: 0 }]);
    const f = fake((c) => (c[2] === 'list' ? { ok: true, out: list } : { ok: true, out: '' }));
    await call(f.handlers['project.remove'], { name: 'web' });
    await call(f.handlers['project.remove'], { name: 'web', purge: true });
    const rm = f.calls.filter((c) => c.cmd[2] === 'remove').map((c) => c.cmd.slice(3).join(' '));
    expect(rm).toEqual(['web --yes', 'web --yes --purge']);
    expect((await call(f.handlers['project.remove'], { name: 'nope' })).message).toContain('nothing to remove');
    expect((await call(f.handlers['project.remove'], { name: 'a b' })).ok).toBe(false);
  });
});

describe('update', () => {
  test('installs, rebuilds the image only when changed (as the runner user), restarts idle projects', async () => {
    const f = fake((c) => (c[2] === 'setup' ? { ok: true, out: 'built localhost/salu-kernel:1' } : { ok: true, out: '' }));
    const r = await call(f.handlers.update, { version: 'v1.2.0' });
    expect(r.ok).toBe(true);
    expect(f.calls[0]!.cmd.slice(1)).toEqual(['update', 'v1.2.0']);
    expect(f.calls[1]!.cmd.slice(1)).toEqual(['kernel', 'setup', '--unattended', '--if-changed']);
    expect(f.calls[1]!.as).toBe('salu');
    expect(r.message).toContain('rebuilt');
    const same = fake((c) => (c[2] === 'setup' ? { ok: true, out: 'kernel image already current' } : { ok: true, out: '' }));
    expect((await call(same.handlers.update, {})).message).toContain('did not change');
  });

  test('a bad version or a failed install is refused with a reason; a failed rebuild says the old image stays', async () => {
    expect((await call(fake().handlers.update, { version: 'latest; reboot' })).ok).toBe(false);
    const f = fake(() => ({ ok: false, out: 'download failed: 404' }));
    expect((await call(f.handlers.update, {})).message).toContain('did not install');
    const g = fake((c) => (c[2] === 'setup' ? { ok: false, out: 'building the kernel image failed' } : { ok: true, out: '' }));
    expect((await call(g.handlers.update, {})).message).toContain('old image');
  });
});

describe('status, ping and the heartbeat', () => {
  test('ping answers with the version; status summarises doctor lines, tickets and disk', async () => {
    const list = JSON.stringify([{ project: 'web', service: 'active', sync: 'active', todo: 1, running: 1, blocked: 0, done: 4 }]);
    const f = fake((c) => (c[2] === 'list' ? { ok: true, out: list } : { ok: true, out: '✓ podman\n✗ gVisor missing' }));
    expect((await call(f.handlers.ping, {})).data).toEqual({ version: '1.2.0' });
    const s = await call(f.handlers.status, {});
    expect(s.ok).toBe(false);
    expect(s.message).toContain('1 problem');
    expect(s.data.tickets).toEqual({ todo: 1, running: 1, blocked: 0, done: 4 });
    expect(s.data.doctor).toEqual(['✓ podman', '✗ gVisor missing']);
  });

  test('the heartbeat is signed over the canonical JSON and carries no secrets', async () => {
    const f = fake();
    const key = Buffer.alloc(32, 7);
    const body = JSON.parse(await heartbeatBody(f.deps, 'salubox', key));
    const { sig, ...rest } = body;
    expect(sig).toBe(new Bun.CryptoHasher('sha256', key).update(canonicalJson(rest)).digest('hex'));
    expect(body).toMatchObject({ v: 1, box: 'salubox', at: 1_759_413_000_000, version: '1.2.0' });
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
  });
});

describe('github.com host key', () => {
  test('is pinned: strict checking, one key type, the given key file only', () => {
    const c = gitSshCommand('/var/lib/salu/p/deploy_key', '/var/lib/salu/p/known_hosts');
    for (const part of ['IdentitiesOnly=yes', 'StrictHostKeyChecking=yes', 'HostKeyAlgorithms=ssh-ed25519', 'UserKnownHostsFile=/var/lib/salu/p/known_hosts']) expect(c).toContain(part);
    expect(() => gitSshCommand('/a b', '/k')).toThrow();
    expect(GITHUB_HOST_KEY.startsWith('AAAAC3NzaC1lZDI1NTE5')).toBe(true);
  });
});
