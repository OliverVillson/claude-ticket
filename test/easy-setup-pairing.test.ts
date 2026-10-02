/**
 * Pairing for real, minus the network: the Mac side (`addBox`, in this process) talks to a "box" made of real
 * `salu box init`, `salu box connect`, `salu box login --stdin` and `salu control watch` processes. ssh runs the
 * remote line in a local shell, sudo and systemctl are stubs, gh is a small fake whose repos are local bare repos
 * (git's insteadOf maps git@github.com:... to them). Then ping, status and login.set go over the control repo.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { addBox } from '../src/boxmac/pair.ts';
import { loadBox } from '../src/boxmac/state.ts';
import { controlApi } from '../src/boxmac/control.ts';
import type { Exec, ExecResult } from '../src/boxmac/exec.ts';
import { git } from '../src/sync/git.ts';

setDefaultTimeout(120_000);
const SRC = resolve(import.meta.dir, '../src/index.ts');
const hasKeygen = spawnSync('ssh-keygen', ['-?']).error === undefined;
const TOKEN = 'sk-ant-oat01-' + 'P'.repeat(50);

let root: string, bin: string, boxHome: string, macHome: string, gitcfg: string, boxEnv: Record<string, string>;
const saved: Record<string, string | undefined> = {};
const ok = (out = ''): ExecResult => ({ ok: true, code: 0, out, err: '' });
const bad = (err: string): ExecResult => ({ ok: false, code: 1, out: '', err });
const repos = new Set<string>();

function bare(slug: string): void {
  const p = join(root, 'gh', `${slug}.git`);
  mkdirSync(join(root, 'gh', slug.split('/')[0]!), { recursive: true });
  git(root, ['init', '-q', '--bare', '-b', 'main', p]);
  const seed = mkdtempSync(join(root, 'seed-'));
  git(seed, ['init', '-q', '-b', 'main']);
  writeFileSync(join(seed, 'README.md'), 'x\n');
  git(seed, ['add', '.']);
  git(seed, ['-c', 'user.email=a@b.c', '-c', 'user.name=x', 'commit', '-q', '-m', 'init']);
  git(seed, ['push', '-q', p, 'HEAD:refs/heads/main']);
  for (const url of [`git@github.com:${slug}.git`, `https://github.com/${slug}.git`]) appendFileSync(gitcfg, `[url "${p}"]\n\tinsteadOf = ${url}\n`);
  repos.add(slug);
}

const run = (line: string, stdin?: string) => {
  const r = spawnSync('sh', ['-c', line], { cwd: boxHome, env: { ...process.env, ...boxEnv }, input: stdin, encoding: 'utf8' });
  return { ok: r.status === 0, code: r.status ?? 1, out: r.stdout ?? '', err: r.stderr ?? '' } as ExecResult;
};
const exec: Exec = {
  async capture(cmd, o) {
    if (cmd[0] === 'ssh') return run(cmd.at(-1)!, o?.stdin);
    if (cmd[0] === 'gh') {
      if (cmd[1] === '--version') return ok('gh 2');
      if (cmd[1] === 'api' && cmd[2] === 'user') return ok('tester\n');
      if (cmd[1] === 'api') return ok(cmd.includes('POST') ? '{}' : '[]');
      if (cmd[1] === 'repo' && cmd[2] === 'view') {
        if (!repos.has(cmd[3]!)) return bad('Could not resolve to a Repository');
        const [owner, name] = cmd[3]!.split('/');
        return ok(JSON.stringify({ owner: { login: owner }, name, isPrivate: true, sshUrl: `git@github.com:${cmd[3]}.git`, url: `https://github.com/${cmd[3]}` }));
      }
      if (cmd[1] === 'repo' && cmd[2] === 'create') return (bare(cmd[3]!), ok());
    }
    return bad('unexpected ' + cmd.join(' '));
  },
  async interactive(cmd) {
    const r = run(cmd.at(-1)!);
    if (!r.ok) console.log(r.out + r.err);
    return r.code;
  },
};

beforeAll(() => {
  if (!hasKeygen) return;
  root = mkdtempSync(join(tmpdir(), 'salu-pair-'));
  bin = join(root, 'bin');
  boxHome = join(root, 'boxhome');
  macHome = join(root, 'machome');
  gitcfg = join(root, 'gitconfig');
  for (const d of [bin, boxHome, macHome, join(root, 'gh')]) mkdirSync(d, { recursive: true });
  writeFileSync(gitcfg, '[user]\n\temail = a@b.c\n\tname = x\n');
  const script = (n: string, body: string) => (writeFileSync(join(bin, n), `#!/bin/sh\n${body}\n`), chmodSync(join(bin, n), 0o755));
  script('sudo', 'exec "$@"');
  script('salu', `exec ${process.execPath} ${SRC} "$@"`);
  // systemctl enable --now salu-control.service: start the real listener in the background
  script('systemctl', `[ "$1" = enable ] && { nohup sh -c 'while :; do ${join(bin, 'salu')} control watch --interval 1; echo "watch exited $?"; sleep 1; done' > ${join(root, 'watch.log')} 2>&1 & echo $! > ${join(root, 'watch.pid')}; }; exit 0`); // looped like the unit's Restart=always
  boxEnv = { PATH: `${bin}:${process.env.PATH}`, SALU_HOME: join(boxHome, '.salu'), SALU_BOX_DIR: join(root, 'boxdir'), SALU_RUNNER_ROOT: join(root, 'rr'), GIT_CONFIG_GLOBAL: gitcfg, GIT_TERMINAL_PROMPT: '0' };
  mkdirSync(boxEnv.SALU_RUNNER_ROOT!, { recursive: true });
  for (const k of ['SALU_HOME', 'GIT_CONFIG_GLOBAL', 'SALU_REMOTE_ALLOW_UNSIGNED']) saved[k] = process.env[k];
  process.env.SALU_HOME = macHome;
  process.env.GIT_CONFIG_GLOBAL = gitcfg;
});
afterAll(() => {
  if (!hasKeygen) return;
  try {
    process.kill(Number(readFileSync(join(root, 'watch.pid'), 'utf8')));
  } catch {}
  for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  if (!process.env.KEEP) rmSync(root, { recursive: true, force: true });
  else console.log('kept', root);
});

describe.skipIf(!hasKeygen)('pairing, with the real Mac code and the real box commands', () => {
  test('salu box add pairs; ping, status and login.set then work', async () => {
    const said: string[] = [];
    const d = { exec, control: controlApi, say: (l: string) => said.push(l), askSecret: async () => TOKEN };
    process.env.SALU_BOX_INSTALL = 'true'; // salu is already "installed"
    const cfg = await addBox(d as any, { host: 'oliver@salubox.local', tokenFile: undefined }, async () => TOKEN);
    expect(cfg.paired).toBe(true);
    expect(loadBox('salubox')?.paired).toBe(true);
    expect(said.join('\n')).toContain('the box answers');

    // The box side holds the keys, the login and the connection, privately.
    const boxdir = join(root, 'boxdir');
    expect(readdirSync(boxdir)).toEqual(expect.arrayContaining(['deploy', 'seal.key', 'box.key', 'mac.key', 'control.json']));
    expect(readFileSync(join(root, 'rr', 'kernel-token'), 'utf8').trim()).toBe(TOKEN);

    // The token never went into the control repo, and the staged files are gone from the box's home.
    const repo = join(root, 'gh', 'tester', 'salu-control.git');
    const all = git(root, ['--git-dir', repo, 'log', '-p', '--all']).out;
    expect(all).not.toContain(TOKEN);
    expect(readdirSync(boxHome).filter((f) => f.startsWith('.salu-pair'))).toEqual([]);

    const st = await controlApi().call(loadBox('salubox')!, 'status', {}, { timeoutMs: 60_000 });
    expect(st.message.length).toBeGreaterThan(0);
    expect(st.message).not.toContain(TOKEN);

    const again = await addBox(d as any, { host: 'oliver@salubox.local' }, async () => TOKEN); // resumable, changes nothing
    expect(again.paired).toBe(true);
  });

  // Found by this test: `salu control watch` exits (code 0) after each round instead of staying up, so under systemd it
  // is restarted every 5 s. Remove `.failing` when src/control's watcher keeps the process alive.
  test.failing('salu control watch stays running by itself', () => {
    expect(readFileSync(join(root, 'watch.log'), 'utf8')).not.toContain('watch exited');
  });
});
