import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addBox, defaultBoxName, makeTokenReader, type Deps } from '../src/boxmac/pair.ts';
import { newProject, slugName, type Registrar } from '../src/boxmac/project.ts';
import { loadBox, loadNew, saveBox, pickBox, type BoxConfig } from '../src/boxmac/state.ts';
import type { ControlApi, ControlReply, Verb } from '../src/boxmac/control.ts';
import type { Exec, ExecResult } from '../src/boxmac/exec.ts';
import { remoteKey } from '../src/sync/format.ts';

const ok = (out = ''): ExecResult => ({ ok: true, code: 0, out, err: '' });
const bad = (err: string, code = 1): ExecResult => ({ ok: false, code, out: '', err });
const INIT = JSON.stringify({ box: 'salubox', deployPub: 'ssh-ed25519 AAAAdeploy box', sealPub: 'c2VhbA==', boxKey: 'Ym94a2V5', version: '1.2.0' });

class Fake {
  calls: { cmd: string[]; stdin?: string }[] = [];
  said: string[] = [];
  controlCalls: { verb: Verb; args: any; secrets?: Record<string, Buffer> }[] = [];
  repos = new Map<string, { isPrivate: boolean }>();
  failOnce = new Set<string>();
  boxReplies: Partial<Record<Verb, ControlReply>> = {};
  keys: string[] = [];
  staged: Record<string, string> = {};
  knownHost = false;
  confirmed = true;
  asked: string[] = [];
  sessions: string[] = [];

  exec: Exec = {
    capture: async (cmd, o) => {
      this.calls.push({ cmd, stdin: o?.stdin });
      const j = cmd.join(' ');
      for (const f of this.failOnce) if (j.includes(f)) { this.failOnce.delete(f); return bad('boom: ' + f); }
      if (cmd[0] === 'ssh') {
        const up = /cat > (\S+)/.exec(j);
        if (up) { this.staged[up[1]!] = o?.stdin ?? ''; return ok(); }
        if (/cat \.salu-pair/.test(j)) return ok(`${INIT}\n`);
        return ok();
      }
      if (cmd[0] === 'gh' && cmd[1] === '--version') return ok('gh 2');
      if (cmd[0] === 'gh' && cmd[1] === 'api' && cmd[2] === 'user') return ok('oliver\n');
      if (cmd[0] === 'gh' && cmd[1] === 'api' && cmd.includes('POST')) { this.keys.push(j); return ok('{}'); }
      if (cmd[0] === 'gh' && cmd[1] === 'api') return ok('[]');
      if (cmd[0] === 'gh' && cmd[1] === 'repo' && cmd[2] === 'view') {
        const r = this.repos.get(cmd[3]!);
        if (!r) return bad('Could not resolve to a Repository');
        const [owner, name] = cmd[3]!.split('/');
        return ok(JSON.stringify({ owner: { login: owner }, name, isPrivate: r.isPrivate, sshUrl: `git@github.com:${cmd[3]}.git`, url: `https://github.com/${cmd[3]}` }));
      }
      if (cmd[0] === 'gh' && cmd[2] === 'create') { expect(cmd).toContain('--private'); expect(cmd).not.toContain('--public'); this.repos.set(cmd[3]!, { isPrivate: true }); return ok(); }
      if (cmd[0] === 'gh' && cmd[2] === 'clone') { mkdirSync(join(cmd[4]!, '.git'), { recursive: true }); return ok(); }
      if (cmd[0] === 'git') return ok('https://github.com/oliver/web.git\n');
      if (cmd[0] === 'ssh-keygen' && cmd[1] === '-F') return this.knownHost ? ok('found') : bad('', 1);
      if (cmd[0] === 'ssh-keyscan') return ok('box.local ssh-ed25519 AAAAhost\n');
      if (cmd[0] === 'ssh-keygen' && cmd[1] === '-lf') return ok(`256 SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA box.local (ED25519)\n`);
      if (cmd[0] === 'ssh-keygen') { const f = cmd[cmd.indexOf('-f') + 1]!; writeFileSync(f, 'PRIVATEKEY\n'); writeFileSync(f + '.pub', 'ssh-ed25519 AAAAproj salu x\n'); return ok(); }
      return bad('unexpected ' + j);
    },
    interactive: async (cmd) => {
      this.calls.push({ cmd });
      const line = cmd.at(-1)!;
      this.sessions.push(line);
      for (const f of this.failOnce) if (line.includes(f)) { this.failOnce.delete(f); return 1; }
      return 0;
    },
  };
  control: ControlApi = {
    call: async (_cfg, verb, args, o) => {
      this.controlCalls.push({ verb, args, secrets: o?.secrets });
      return this.boxReplies[verb] ?? { ok: true, message: `${verb} ok`, data: { lines: ['sandbox: green'] } };
    },
  };
  deps = (): Deps => ({ exec: this.exec, control: () => this.control, say: (l) => this.said.push(l), askSecret: async () => 'sk-ant-oat01-' + 'x'.repeat(40), confirm: async (q) => { this.asked.push(q); return this.confirmed; } });
}

const token = () => Promise.resolve('sk-ant-oat01-' + 'x'.repeat(40));

const HOME0 = process.env.SALU_HOME;
const REAL_HOME = process.env.HOME;
const KEY0 = process.env.SALU_REMOTE_KEY;
afterEach(() => {
  for (const [k, v] of [['HOME', REAL_HOME], ['SALU_HOME', HOME0], ['SALU_REMOTE_KEY', KEY0]] as const) v === undefined ? delete process.env[k] : (process.env[k] = v);
});
beforeEach(() => {
  process.env.SALU_HOME = mkdtempSync(join(tmpdir(), 'salu-boxmac-'));
  process.env.HOME = mkdtempSync(join(tmpdir(), 'salu-home-'));
  delete process.env.SALU_REMOTE_KEY;
});

describe('salu box add', () => {
  test('pairs end to end and keeps secrets out of argv', async () => {
    const f = new Fake();
    const cfg = await addBox(f.deps(), { host: 'oliver@192.168.0.64', name: 'salubox' }, token);
    expect(cfg.paired).toBe(true);
    expect(loadBox('salubox')?.repoSsh).toBe('git@github.com:oliver/salu-control.git');
    expect(f.keys.some((k) => k.includes('read_only=false') && k.includes('AAAAdeploy'))).toBe(true);
    // two terminal sessions (keys, then connect + login), each one sudo prompt; secrets only in staged files
    expect(f.sessions.length).toBe(2);
    expect(f.sessions[0]).toContain('sudo salu box init --json --name salubox');
    expect(f.sessions[1]).toMatch(/^sudo sh -c 'salu box connect --url git@github.com:oliver\/salu-control.git --mac-key - < \S+ && salu box login --stdin < \S+'$/);
    const staged = Object.values(f.staged);
    expect(staged).toContain(loadBox('salubox')!.macKey + '\n');
    expect(staged.some((v) => v.startsWith('sk-ant-oat01-'))).toBe(true);
    const argv = f.calls.map((c) => c.cmd.join(' ')).join('\n');
    expect(argv).not.toContain(loadBox('salubox')!.macKey!);
    expect(argv).not.toContain('sk-ant');
    expect(f.calls.some((c) => /rm -f \.salu-pair-\w+ \.salu-pair-\w+/.test(c.cmd.join(' ')))).toBe(true);
    expect(f.controlCalls.map((c) => c.verb)).toEqual(['ping', 'status']);
    expect(f.said.join('\n')).toContain('sandbox: green');
  });

  test('stops where it failed and a second run resumes', async () => {
    const f = new Fake();
    f.failOnce.add('box connect');
    await expect(addBox(f.deps(), { host: 'oliver@box.local' }, token)).rejects.toThrow(/refused a step/);
    expect(loadBox('box')?.keyAdded).toBe(true);
    expect(loadBox('box')?.connected).toBeUndefined();
    expect(f.sessions.filter((l) => l.includes('box init')).length).toBe(1);
    expect(f.calls.some((c) => /rm -f/.test(c.cmd.join(' ')))).toBe(true);
    await addBox(f.deps(), { host: 'oliver@box.local' }, token);
    expect(f.sessions.filter((l) => l.includes('box init')).length).toBe(1);
    expect(f.calls.filter((c) => c.cmd[1] === 'repo' && c.cmd[2] === 'create').length).toBe(1);
    expect(loadBox('box')?.paired).toBe(true);
  });

  test('installs salu only when missing, in the same terminal session as init', async () => {
    const f = new Fake();
    await addBox(f.deps(), { host: 'oliver@box.local' }, token);
    expect(f.sessions[0]).toMatch(/command -v salu .*install-box\.sh.*&& sudo salu box init/);
    expect(f.calls.find((c) => c.cmd.includes('-t'))).toBeTruthy();
  });

  test('shows the host key fingerprint, asks once, and saves exactly that key; ssh keeps its normal check', async () => {
    const f = new Fake();
    await addBox(f.deps(), { host: 'oliver@box.local' }, token);
    expect(f.asked.length).toBe(1);
    expect(f.said.join('\n')).toContain('SHA256:' + 'A'.repeat(43));
    expect(f.said.join('\n')).toContain('ssh_host_ed25519_key.pub');
    expect(require('node:fs').readFileSync(join(process.env.HOME!, '.ssh', 'known_hosts'), 'utf8')).toContain('ssh-ed25519 AAAAhost');
    for (const c of f.calls) expect(c.cmd.join(' ')).not.toMatch(/StrictHostKeyChecking=(no|accept-new)/);
  });

  test('a fingerprint that is not confirmed stops before anything is sent', async () => {
    const f = new Fake();
    f.confirmed = false;
    await expect(addBox(f.deps(), { host: 'oliver@box.local' }, token)).rejects.toThrow(/not confirmed/);
    expect(f.calls.some((c) => c[0 as never] === undefined && c.cmd[0] === 'ssh')).toBe(false);
    expect(f.sessions.length).toBe(0);
  });

  test('--host-key checks without asking, and a different key is refused', async () => {
    const f = new Fake();
    await addBox(f.deps(), { host: 'oliver@box.local', hostKey: 'SHA256:' + 'A'.repeat(43) }, token);
    expect(f.asked.length).toBe(0);
    const g = new Fake();
    await expect(addBox(g.deps(), { host: 'oliver@other.local', hostKey: 'SHA256:' + 'B'.repeat(43) }, token)).rejects.toThrow(/Someone else may be answering/);
    expect(g.sessions.length).toBe(0);
  });

  test('a host ssh already knows is not asked about', async () => {
    const f = new Fake();
    f.knownHost = true;
    await addBox(f.deps(), { host: 'oliver@box.local' }, token);
    expect(f.asked.length).toBe(0);
  });

  test('refuses a public control repo and bad host names', async () => {
    const f = new Fake();
    f.repos.set('oliver/salu-control', { isPrivate: false });
    await expect(addBox(f.deps(), { host: 'oliver@box.local' }, token)).rejects.toThrow(/is public/);
    await expect(addBox(f.deps(), { host: 'nohost' }, token)).rejects.toThrow(/user@host/);
    expect(f.controlCalls.length).toBe(0);
  });

  test('a box that does not answer the ping fails in plain words', async () => {
    const f = new Fake();
    f.boxReplies.ping = { ok: false, message: 'no answer in 90 s. Is the box on?' };
    await expect(addBox(f.deps(), { host: 'oliver@box.local' }, token)).rejects.toThrow(/did not answer.*Is the box on/);
    expect(loadBox('box')?.paired).toBeUndefined();
  });

  test('names and tokens', async () => {
    expect(defaultBoxName('oliver@SaluBox.local')).toBe('salubox');
    const f = new Fake();
    const dir = mkdtempSync(join(tmpdir(), 'tok-'));
    writeFileSync(join(dir, 't'), 'sk-ant-oat01-abc\ndefghijklmnopqrstuvwxyz\n');
    expect(await makeTokenReader(f.deps(), join(dir, 't'), (p) => require('node:fs').readFileSync(p, 'utf8'))()).toBe('sk-ant-oat01-abcdefghijklmnopqrstuvwxyz');
    await expect(makeTokenReader(f.deps(), join(dir, 't'), () => 'short')()).rejects.toThrow(/does not look like/);
  });
});

const box: BoxConfig = { box: 'salubox', host: 'oliver@box', paired: true, sealPub: 'x', boxKey: 'y', macKey: 'z' };
const reg = (): Registrar & { log: string[] } => {
  const log: string[] = [];
  return { log, hasProject: () => false, hasRemote: () => false, addProject: async (n, p) => void log.push(`project ${n} ${p}`), addRemote: async (n, u) => void log.push(`remote ${n} ${u}`) };
};

describe('salu new', () => {
  test('makes the repo, the key, asks the box, then registers here', async () => {
    const f = new Fake();
    const r = reg();
    const dir = mkdtempSync(join(tmpdir(), 'new-'));
    await newProject(f.deps(), box, { name: 'web', path: join(dir, 'web') }, r);
    const c = f.controlCalls[0]!;
    expect(c.verb).toBe('project.create');
    expect(c.args).toEqual({ name: 'web', repo: 'git@github.com:oliver/web.git' });
    expect(c.secrets!.deployKey.toString()).toContain('PRIVATEKEY');
    expect(c.secrets!.signingKey.toString()).toBe(remoteKey()!);
    expect(JSON.stringify(c.args)).not.toContain('PRIVATEKEY');
    expect(r.log).toEqual([`project web ${join(dir, 'web')}`, 'remote web https://github.com/oliver/web.git']);
    expect(loadNew('web')).toBeNull();
    expect(f.keys[0]).toContain('AAAAproj');
  });

  test('refuses a public repo and sends nothing to the box', async () => {
    const f = new Fake();
    f.repos.set('oliver/web', { isPrivate: false });
    await expect(newProject(f.deps(), box, { name: 'web' }, reg())).rejects.toThrow(/is public/);
    expect(f.controlCalls.length).toBe(0);
    expect(f.keys.length).toBe(0);
  });

  test('uses an existing private repo and keeps the same key when retrying after a box failure', async () => {
    const f = new Fake();
    f.repos.set('oliver/web', { isPrivate: true });
    f.boxReplies['project.create'] = { ok: false, message: 'clone failed: the deploy key has no write access' };
    const dir = mkdtempSync(join(tmpdir(), 'new-'));
    const o = { name: 'web', path: join(dir, 'web') };
    await expect(newProject(f.deps(), box, o, reg())).rejects.toThrow(/clone failed.*run the same command again/s);
    expect(f.calls.some((c) => c.cmd[2] === 'create')).toBe(false);
    const pub = loadNew('web')!.deployPub;
    delete f.boxReplies['project.create'];
    await newProject(f.deps(), box, o, reg());
    expect(f.calls.filter((c) => c.cmd[0] === 'ssh-keygen').length).toBe(1);
    expect(f.controlCalls.length).toBe(2);
    expect(pub).toContain('AAAAproj');
  });

  test('name rules', () => {
    expect(slugName('My Web App!')).toBe('my-web-app');
    expect(slugName('***')).toBe('');
  });
});

describe('plumbing', () => {
  test('pickBox picks the one paired box, or asks which', () => {
    expect(() => pickBox()).toThrow(/salu box add/);
    saveBox(box);
    expect(pickBox().box).toBe('salubox');
    saveBox({ ...box, box: 'other' });
    expect(() => pickBox()).toThrow(/--on|--box/);
    expect(pickBox('other').box).toBe('other');
  });

  test('every printed command fits in 55 characters', async () => {
    const f = new Fake();
    await addBox(f.deps(), { host: 'oliver@192.168.0.64', name: 'salubox' }, token);
    const dir = mkdtempSync(join(tmpdir(), 'new-'));
    await newProject(f.deps(), loadBox('salubox')!, { name: 'a-rather-long-project-name-forty-chars-x', path: join(dir, 'p') }, reg());
    for (const l of f.said.join('\n').split('\n')) if (/^\s+(salu|cd|gh|ssh) /.test(l)) expect(l.length).toBeLessThanOrEqual(55);
  });
});

import { box as boxCmd } from '../src/cli/commands/box.ts';
describe('cli', () => {
  test('salu box --help prints the help; list is empty without a box', async () => {
    const out: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => void out.push(a.join(' '));
    try {
      expect(await boxCmd({ positional: [], flags: { help: true } })).toBe(0);
      expect(await boxCmd({ positional: ['list'], flags: {} })).toBe(0);
    } finally {
      console.log = orig;
    }
    expect(out.join('\n')).toContain('salu box add');
    expect(out.join('\n')).toContain('no box yet');
  });
});

import { realControlApi } from '../src/boxmac/bridge.ts';
import { gitTransport } from '../src/control/transport.ts';
import { runWatcher, type Handlers } from '../src/control/watcher.ts';
import { randomBytes } from 'node:crypto';
import { generateSealKeys, openSealed } from '../src/control/seal.ts';

describe('real control channel', () => {
  test('a command goes through a git repo to a watcher and the answer comes back; secrets arrive sealed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ctl-'));
    const bare = join(root, 'c.git');
    Bun.spawnSync(['git', 'init', '-q', '--bare', '-b', 'main', bare]);
    const macKey = randomBytes(32), boxKey = randomBytes(32), seal = generateSealKeys();
    const got: Record<string, string> = {};
    const handlers = new Proxy({} as Handlers, {
      get: (_t, verb: string) => async (a: any) => {
        if (verb === 'project.create') got.deployKey = a.secret('deployKey').toString();
        return { ok: true, message: `${verb} done`, data: { args: a.args } };
      },
    });
    const w = runWatcher(gitTransport({ url: bare, dir: join(root, 'boxwc') }), handlers, { box: 'salubox', macKey, boxKey, sealKey: seal.privateKey, handledFile: join(root, 'handled') });
    const cfg: BoxConfig = { box: 'salubox', host: 'o@h', repoHttps: bare, macKey: macKey.toString('base64'), boxKey: boxKey.toString('base64'), sealPub: seal.publicKey.toString('base64') };
    const pump = setInterval(() => void w.tick(), 100);
    try {
      const r = await realControlApi.call(cfg, 'project.create', { name: 'web', repo: 'git@github.com:o/web.git' }, { secrets: { deployKey: Buffer.from('PRIVATE'), signingKey: Buffer.from('SIGN') }, timeoutMs: 20_000 });
      expect(r).toMatchObject({ ok: true, message: 'project.create done' });
      expect(got.deployKey).toBe('PRIVATE');
    } finally {
      clearInterval(pump);
      w.stop();
    }
  }, 30_000);

  test('an unpaired box gives a plain message instead of crashing', async () => {
    const r = await realControlApi.call({ box: 'x', host: 'o@h' }, 'ping', {});
    expect(r.ok).toBe(false);
    expect(r.message).toContain('salu box add');
  });
});
