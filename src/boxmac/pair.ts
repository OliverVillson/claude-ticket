import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { ticketHome } from '../core/paths.ts';
import { CliError } from '../core/errors.ts';
import type { Exec } from './exec.ts';
import { BOX_NAME_RE, loadBox, saveBox, type BoxConfig } from './state.ts';
import { createPrivateRepo, ensureDeployKey, ghReady, viewRepo } from './github.ts';
import type { ControlApi, ControlReply } from './control.ts';

export interface Deps {
  exec: Exec;
  control: () => ControlApi;
  say(line: string): void;
  /** Ask for a secret without echoing it. */
  askSecret(question: string): Promise<string>;
}

const INSTALL_DEFAULT = 'curl -fsSL https://raw.githubusercontent.com/OliverVillson/salu/main/scripts/install-box.sh | sudo bash';
const HOST_RE = /^([A-Za-z0-9._-]+)@([A-Za-z0-9][A-Za-z0-9.-]*)$/;

/** "oliver@salubox.local" -> box name "salubox". */
export function defaultBoxName(host: string): string {
  const h = (HOST_RE.exec(host)?.[2] ?? host).split('.')[0]!.toLowerCase();
  return h.replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
}

export function sshBase(host: string): string[] {
  const dir = join(ticketHome(), 'boxes');
  mkdirSync(dir, { recursive: true });
  // One connection is kept open for two minutes, so a password is typed once, not at every step.
  return ['ssh', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ControlMaster=auto', '-o', `ControlPath=${join(dir, '%C')}`, '-o', 'ControlPersist=120', host];
}

const sshProblem = (host: string, err: string): string => {
  if (/permission denied/i.test(err)) return `ssh could not log in to ${host}. Check the user name and password, or set up a key with: ssh-copy-id ${host}`;
  if (/could not resolve|no route|timed out|refused|unreachable/i.test(err)) return `could not reach ${host}. Is the box on, and are you on its network (or Tailscale)?`;
  return `ssh to ${host} failed: ${err.trim().split('\n').pop() || 'no details'}`;
};

const tmpName = () => `.salu-pair-${randomBytes(6).toString('hex')}`;

/** Run a shell line on the box inside one `ssh -t`, so sudo can ask for its password once. */
async function inTerminal(d: Deps, host: string, line: string): Promise<number> {
  return d.exec.interactive([...sshBase(host).slice(0, -1), '-t', host, line]);
}

/** Put a secret in a private file in the box user's home (ssh stdin, never argv), to be read by a shell redirect. */
async function stage(d: Deps, host: string, file: string, secret: string): Promise<void> {
  const r = await d.exec.capture([...sshBase(host), `umask 077; cat > ${file}`], { stdin: secret, timeoutMs: 60_000 });
  if (!r.ok) throw new CliError(r.err ? sshProblem(host, r.err) : `could not reach ${host}`);
}

const unstage = (d: Deps, host: string, files: string[]) => d.exec.capture([...sshBase(host), `rm -f ${files.join(' ')}`], { timeoutMs: 30_000 }).catch(() => undefined);

const need = (b: BoxConfig, ...f: (keyof BoxConfig)[]) => {
  for (const k of f) if (!b[k]) throw new CliError(`the saved state for box "${b.box}" is incomplete (${k}). Start over: salu box add ${b.host} --name ${b.box} --fresh`);
};

export interface AddOpts {
  host: string;
  name?: string;
  repo?: string; // owner/name of the control repo
  tokenFile?: string; // read the Claude token from here instead of asking
  fresh?: boolean;
}

export async function addBox(d: Deps, o: AddOpts, readToken: () => Promise<string>): Promise<BoxConfig> {
  if (!HOST_RE.test(o.host)) throw new CliError(`"${o.host}" should look like user@host, for example oliver@192.168.0.64`);
  const name = o.name ?? defaultBoxName(o.host);
  if (!BOX_NAME_RE.test(name)) throw new CliError(`"${name}" is not a good box name (use a-z, 0-9 and -, up to 32). Pick one with --name`);
  let cfg: BoxConfig = (!o.fresh && loadBox(name)) || { box: name, host: o.host };
  if (cfg.host !== o.host) throw new CliError(`box "${name}" is already set up for ${cfg.host}. Pick another name with --name, or start over with --fresh`);
  const persist = () => saveBox(cfg);
  persist();

  // 1. salu on the box (installed if missing), and its keys. One terminal session: sudo asks once.
  if (!cfg.sealPub) {
    d.say('Reaching the box. It will ask for its sudo password.');
    const out = tmpName();
    const install = process.env.SALU_BOX_INSTALL ?? INSTALL_DEFAULT;
    const code = await inTerminal(d, cfg.host, `( command -v salu >/dev/null || { ${install}; } ) && sudo salu box init --json --name ${name} > ${out}`);
    const r = await d.exec.capture([...sshBase(cfg.host), `cat ${out}; rm -f ${out}`], { timeoutMs: 30_000 });
    if (code !== 0 || !r.ok) throw new CliError(code === 255 ? sshProblem(cfg.host, r.err || 'ssh failed') : `setting up the box stopped (exit ${code}). Run salu box add again and it continues from here.`);
    const line = r.out.split('\n').map((s) => s.trim()).filter((s) => s.startsWith('{')).pop();
    let j: any;
    try {
      j = JSON.parse(line ?? '');
    } catch {
      throw new CliError('the box answered, but not in a way this salu understands. Update both sides: salu update');
    }
    if (!j.deployPub || !j.sealPub || !j.boxKey) throw new CliError('the box did not return all its keys. Update salu on the box: salu box update');
    cfg = { ...cfg, installed: true, deployPub: j.deployPub, sealPub: j.sealPub, boxKey: j.boxKey, version: j.version };
    persist();
    d.say(`✓ salu ${j.version ?? ''} is on the box`);
  }

  // 2. the control repo on GitHub, with the box's deploy key.
  if (!cfg.keyAdded) {
    const owner = await ghReady(d.exec);
    const slug = o.repo ?? `${owner}/salu-control`;
    let info = await viewRepo(d.exec, slug);
    if (info && !info.isPrivate) throw new CliError(`${slug} is public, and the control repo must be private (it carries your commands). Make it private on GitHub, or pick another with --repo owner/name`);
    if (!info) info = await createPrivateRepo(d.exec, slug);
    need(cfg, 'deployPub');
    await ensureDeployKey(d.exec, slug, cfg.deployPub!, `salu box ${name}`);
    cfg = { ...cfg, repoSsh: info.sshUrl, repoHttps: info.httpsUrl, keyAdded: true };
    persist();
    d.say(`✓ private repo ${slug}`);
  }

  // 3 + 4. tell the box about the repo, and give it the Claude login. Secrets are staged in private
  // files and read by redirect inside one terminal session, so sudo can ask for its password once.
  if (!cfg.connected || !cfg.loggedIn) {
    need(cfg, 'repoSsh');
    if (!/^git@github\.com:[\w.-]+\/[\w.-]+\.git$/.test(cfg.repoSsh!)) throw new CliError(`unexpected repo address ${cfg.repoSsh}. Start over: salu box add ${cfg.host} --fresh`);
    cfg.macKey ??= randomBytes(32).toString('base64');
    persist();
    const token = cfg.loggedIn ? undefined : await readToken();
    const files: string[] = [];
    const steps: string[] = [];
    try {
      if (!cfg.connected) {
        const f = tmpName();
        await stage(d, cfg.host, f, cfg.macKey + '\n');
        files.push(f);
        steps.push(`salu box connect --url ${cfg.repoSsh} --mac-key - < ${f}`);
      }
      if (token) {
        const f = tmpName();
        await stage(d, cfg.host, f, token + '\n');
        files.push(f);
        steps.push(`salu box login --stdin < ${f}`);
      }
      d.say('Setting up the box (sudo may ask for its password again).');
      const code = await inTerminal(d, cfg.host, `sudo sh -c '${steps.join(' && ')}'`);
      if (code !== 0) throw new CliError(`the box refused a step (exit ${code}); its message is above. Run salu box add again to retry from here.`);
    } finally {
      if (files.length) await unstage(d, cfg.host, files);
    }
    cfg = { ...cfg, connected: true, loggedIn: true };
    persist();
    d.say('✓ the box watches the repo and is logged in to Claude');
  }

  // 5. does it answer?
  d.say('Waiting for the box to answer (up to a minute)...');
  const ping = await d.control().call(cfg, 'ping', {}, { timeoutMs: 90_000 });
  if (!ping.ok) throw new CliError(`the box did not answer the ping: ${ping.message}`);
  cfg = { ...cfg, paired: true };
  persist();
  d.say('✓ the box answers');
  const st = await d.control().call(cfg, 'status', {}, { timeoutMs: 120_000 });
  for (const l of statusLines(st)) d.say(l);
  d.say(`\nDone. Next: salu new <name>`);
  return cfg;
}

export function statusLines(r: ControlReply): string[] {
  const lines = [r.ok ? r.message : `✗ ${r.message}`];
  const data = r.data as { lines?: string[]; tickets?: unknown; disk?: unknown } | undefined;
  if (data?.lines) lines.push(...data.lines.map((l) => `  ${l}`));
  if (data?.tickets !== undefined) lines.push(`  tickets: ${typeof data.tickets === 'object' ? JSON.stringify(data.tickets) : data.tickets}`);
  if (data?.disk !== undefined) lines.push(`  disk: ${typeof data.disk === 'object' ? JSON.stringify(data.disk) : data.disk}`);
  return lines;
}

/** Ask the box to store the Claude login (sealed, through the control channel). */
export async function loginViaControl(d: Deps, cfg: BoxConfig, token: string): Promise<ControlReply> {
  return d.control().call(cfg, 'login.set', { kind: 'subscription' }, { secrets: { token: Buffer.from(token) }, timeoutMs: 120_000 });
}

/** Run `claude setup-token` and ask for what it printed. A file or SALU_BOX_TOKEN skips both. */
export function makeTokenReader(d: Deps, tokenFile: string | undefined, readFile: (p: string) => string): () => Promise<string> {
  return async () => {
    let t = '';
    if (tokenFile) t = readFile(tokenFile);
    else if (process.env.SALU_BOX_TOKEN) t = process.env.SALU_BOX_TOKEN;
    else {
      d.say('Now your Claude login. A browser opens; sign in with the account the box should use.');
      const code = await d.exec.interactive(['claude', 'setup-token']);
      if (code !== 0) throw new CliError('`claude setup-token` did not finish. Is Claude Code installed here? Try it by hand, then run salu box add again.');
      t = await d.askSecret('Paste the token it printed (it stays hidden): ');
    }
    t = t.replace(/\s+/g, '');
    if (t.length < 20 || !/^[A-Za-z0-9_\-.]+$/.test(t)) throw new CliError('that does not look like a Claude token (it starts with sk-ant-). Run `claude setup-token` and paste what it prints.');
    return t;
  };
}
