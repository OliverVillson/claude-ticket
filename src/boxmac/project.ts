import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { CliError } from '../core/errors.ts';
import { generateKey, remoteKey, saveKey } from '../sync/format.ts';
import { clearNew, loadNew, saveNew, type BoxConfig, type NewState } from './state.ts';
import { createPrivateRepo, ensureDeployKey, ghReady, viewRepo } from './github.ts';
import type { Deps } from './pair.ts';

export const PROJECT_NAME_RE = /^[a-z0-9-]{1,40}$/;

/** "My Web App" -> "my-web-app". */
export function slugName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

export interface NewOpts {
  name: string;
  repo?: string; // owner/name; default <you>/<name>
  path?: string; // where to clone on this computer; default ./<name>
  concurrency?: number;
}

/** Hooks into the rest of salu, so the project steps can be tested without a database. */
export interface Registrar {
  hasProject(name: string): boolean;
  hasRemote(name: string): boolean;
  addProject(name: string, path: string): Promise<void>;
  addRemote(name: string, url: string): Promise<void>;
}

async function makeDeployKey(d: Deps, name: string): Promise<{ priv: string; pub: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'salu-key-'));
  try {
    const f = join(dir, 'k');
    const r = await d.exec.capture(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', `salu ${name}`, '-f', f]);
    if (!r.ok) throw new CliError('ssh-keygen failed, so no deploy key could be made. Is OpenSSH installed?');
    return { priv: readFileSync(f, 'utf8'), pub: readFileSync(`${f}.pub`, 'utf8').trim() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function newProject(d: Deps, box: BoxConfig, o: NewOpts, reg: Registrar): Promise<void> {
  if (!PROJECT_NAME_RE.test(o.name)) throw new CliError(`"${o.name}" is not a good project name (use a-z, 0-9 and -, up to 40).`);
  let st: NewState = loadNew(o.name) ?? { name: o.name, box: box.box };
  if (st.box !== box.box) st = { name: o.name, box: box.box };
  const persist = () => saveNew(st);
  const folder = resolve(o.path ?? o.name);

  // 1. a private repo. A public one is refused, an existing private one is used as it is.
  if (!st.repoSsh) {
    const owner = await ghReady(d.exec);
    const slug = o.repo ?? `${owner}/${o.name}`;
    let info = await viewRepo(d.exec, slug);
    if (info && !info.isPrivate) throw new CliError(`${slug} is public. A box project must be private, because it carries your tickets and code. Make it private on GitHub, or give another repo with --repo owner/name`);
    if (info) d.say(`Using your existing private repo ${slug}`);
    else {
      info = await createPrivateRepo(d.exec, slug);
      d.say(`✓ made private repo ${slug}`);
    }
    st = { ...st, repo: slug, repoSsh: info.sshUrl, repoHttps: info.httpsUrl };
    persist();
  }

  // 2. the project's own deploy key (works for this one repo only), with write access.
  if (!st.created) {
    if (!st.deployPriv || !st.deployPub) {
      const k = await makeDeployKey(d, o.name);
      st = { ...st, deployPriv: k.priv, deployPub: k.pub, keyAdded: false };
      persist();
    }
    if (!st.keyAdded) {
      await ensureDeployKey(d.exec, st.repo!, st.deployPub!, `salu box ${box.box}: ${o.name}`);
      st = { ...st, keyAdded: true };
      persist();
      d.say('✓ deploy key added');
    }

    // 3. one signing key for this computer's remotes (made once, reused by every project and box).
    let key = remoteKey();
    if (!key) {
      key = generateKey();
      saveKey(key);
    }

    // 4. ask the box to set the project up, and wait for its answer.
    d.say('Asking the box to set it up (the first time takes a minute or two)...');
    const reply = await d.control().call(box, 'project.create', { name: o.name, repo: st.repoSsh, ...(o.concurrency ? { concurrency: o.concurrency } : {}) }, { secrets: { deployKey: Buffer.from(st.deployPriv!), signingKey: Buffer.from(key) }, timeoutMs: 300_000 });
    if (!reply.ok) throw new CliError(`the box could not set up "${o.name}": ${reply.message}\nNothing was lost; run the same command again to retry.`);
    st = { ...st, created: true, deployPriv: undefined };
    persist();
    d.say(`✓ the box runs "${o.name}"`);
  }

  // 5. this computer: a clone, the project, and the remote.
  if (!existsSync(join(folder, '.git'))) {
    const url = st.repoHttps ?? st.repoSsh!;
    const r = await d.exec.capture(['gh', 'repo', 'clone', st.repo!, folder]);
    if (!r.ok) throw new CliError(`could not copy the repo to ${folder}: ${r.err.trim().split('\n').pop() || 'git failed'}\nThe box is ready. Clone ${url} there yourself, then run salu new again.`);
  }
  if (!reg.hasProject(o.name)) await reg.addProject(o.name, folder);
  if (!reg.hasRemote(o.name)) await reg.addRemote(o.name, await originOf(d, folder, st.repoHttps ?? st.repoSsh!));
  clearNew(o.name);
  const add = `salu add "idea" -p ${o.name}`;
  d.say(`\nDone. Add a ticket with:\n  ${add.length <= 55 ? add : 'salu add "idea" -p <project>'}`);
}

async function originOf(d: Deps, folder: string, fallback: string): Promise<string> {
  const r = await d.exec.capture(['git', 'remote', 'get-url', 'origin'], { cwd: folder });
  return r.ok && r.out.trim() ? r.out.trim() : fallback;
}
