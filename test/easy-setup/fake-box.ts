/**
 * A box and a Mac in one process, with no ssh and no gh:
 *   - the control repo is a local bare git repo,
 *   - the Mac and the box each get their own SALU_HOME-style folder,
 *   - "salu box init" and the pairing step are done by `pair()` with the same keys the contract names,
 *   - each project's private repo is another local bare repo.
 * Handlers are the real ones when src/box/handlers exists, else recording fakes that follow the contract.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from '../../src/sync/git.ts';
import { control } from './control.ts';
import { newSealKeys, rm, tmp, type BoxConfig, type ControlTransport, type Handlers, type Verb } from './ref-control.ts';

export interface Call {
  verb: Verb;
  args: any;
  secrets: Record<string, string>;
}
export interface FakeBox {
  root: string;
  controlRepo: string; // the bare repo both sides talk through
  macHome: string;
  boxHome: string;
  cfg: BoxConfig; // what the Mac keeps in ~/.salu/boxes/<box>.json
  mac: ControlTransport;
  calls: Call[]; // what the fake handlers received
  newProjectRepo(name: string): string; // a private repo for a project, as a local bare repo
  send(verb: Verb, args?: object, secrets?: Record<string, Buffer>, o?: { timeoutMs?: number }): Promise<import('./ref-control.ts').Reply>;
  stop(): void;
  cleanup(): void;
}

export const BOX = 'salubox';
export const NAME_RE = /^[a-z0-9-]{1,40}$/;
export const REPO_RE = /^git@github\.com:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/;

/** Handlers that obey the contract's validation rules, for use until piece 3 lands. */
export function fakeHandlers(calls: Call[], overrides: Partial<Handlers> = {}): Handlers {
  const rec = (verb: Verb, args: any, names: string[], secret: (f: string) => Buffer) => {
    const secrets: Record<string, string> = {};
    for (const n of names) secrets[n] = secret(n).toString('utf8');
    calls.push({ verb, args, secrets });
  };
  const bad = (message: string) => ({ ok: false, message });
  return {
    ping: async ({ args, secret }) => (rec('ping', args, [], secret), { ok: true, message: 'pong', data: { version: '0.0.0-fake' } }),
    status: async ({ args, secret }) => (rec('status', args, [], secret), { ok: true, message: 'doctor: ok, 0 tickets, 900 GB free', data: { tickets: 0 } }),
    'login.set': async ({ args, secret }) => {
      if (args.kind !== 'subscription') return bad('login kind must be subscription');
      rec('login.set', args, ['token'], secret);
      return { ok: true, message: 'box login stored' };
    },
    'project.create': async ({ args, secret }) => {
      if (!NAME_RE.test(args.name ?? '')) return bad('project names use a-z, 0-9 and - (up to 40 characters)');
      if (!REPO_RE.test(args.repo ?? '') && !String(args.repo).startsWith('file://')) return bad('the repo must look like git@github.com:you/repo.git');
      rec('project.create', args, ['deployKey', 'signingKey'], secret);
      return { ok: true, message: `project ${args.name} is running on the box` };
    },
    'project.remove': async ({ args, secret }) => (rec('project.remove', args, [], secret), { ok: true, message: `project ${args.name} removed` }),
    update: async ({ args, secret }) => (rec('update', args, [], secret), { ok: true, message: 'up to date' }),
    ...overrides,
  };
}

export async function fakeBox(o: { handlers?: (calls: Call[]) => Handlers; intervalMs?: number } = {}): Promise<FakeBox> {
  const root = tmp('salu-fakebox-');
  const controlRepo = join(root, 'salu-control.git');
  git(root, ['init', '-q', '--bare', '-b', 'main', controlRepo]);
  // The bare repo starts empty; seed `main` so both sides can fetch it (GitHub's "create repo --add-readme").
  const seed = join(root, 'seed');
  git(root, ['init', '-q', '-b', 'main', seed]);
  writeFileSync(join(seed, 'README.md'), 'salu control repo\n');
  git(seed, ['add', '.']);
  git(seed, ['-c', 'user.email=a@b.c', '-c', 'user.name=x', 'commit', '-q', '-m', 'init']);
  git(seed, ['push', '-q', controlRepo, 'HEAD:refs/heads/main']);

  const macHome = join(root, 'mac-home');
  const boxHome = join(root, 'box-home');
  mkdirSync(macHome, { recursive: true });
  mkdirSync(boxHome, { recursive: true });

  // "salu box init" on the box: seal key pair and box signing key. The Mac adds its own signing key.
  const seal = newSealKeys();
  const boxKey = randomBytes(32);
  const macKey = randomBytes(32);
  const cfg: BoxConfig = { box: BOX, macKey, boxKey, sealPub: seal.pub };

  const calls: Call[] = [];
  const handlers = o.handlers ? o.handlers(calls) : fakeHandlers(calls);
  const boxSide = control.gitTransport({ url: controlRepo, dir: join(boxHome, 'control') });
  const watcher = control.runWatcher(boxSide, handlers, { box: BOX, macKey, boxKey, sealKey: seal.priv, intervalMs: o.intervalMs ?? 100 });
  const mac = control.gitTransport({ url: controlRepo, dir: join(macHome, 'control') });

  return {
    root,
    controlRepo,
    macHome,
    boxHome,
    cfg,
    mac,
    calls,
    newProjectRepo(name) {
      const p = join(root, 'repos', `${name}.git`);
      mkdirSync(join(root, 'repos'), { recursive: true });
      git(root, ['init', '-q', '--bare', p]);
      return p;
    },
    async send(verb, args = {}, secrets = {}, opt = {}) {
      const id = await control.sendCommand(mac, cfg, verb, args, secrets);
      return control.waitReply(mac, cfg, id, { timeoutMs: opt.timeoutMs ?? 15000 });
    },
    stop: () => watcher.stop(),
    cleanup() {
      watcher.stop();
      rm(root);
    },
  };
}
