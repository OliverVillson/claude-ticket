import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import type { Parsed } from '../args.ts';
import { flagBool, flagStr } from '../args.ts';
import { CliError } from '../../core/errors.ts';
import { dim, green, red } from '../../core/ansi.ts';
import { checkClaude } from '../../core/claude-bin.ts';
import { sandboxSupport } from '../../core/kernel.ts';
import { selfCommand } from '../../orchestrator/index.ts';
import {
  NO_TOKEN_WARNING, SETUP_TOKEN_WARNING, SYNC_UNIT_NAME, UNIT_NAME, boxProblems, renderEnvFile, renderSyncUnit, renderUnit, requireRunnerName, runnerEnvFile, runnerEtc, runnerHome, runnerRoot, runnerWork, serviceName, syncServiceName, unitDir,
  type AuthMode,
} from '../../core/runner.ts';
import { confirm, helpIf } from './_shared.ts';

const HELP = `salu runner <command>      run salu unattended on an always-on Linux box (one orchestrator per project, under systemd)

  salu runner doctor                          check this box: systemd, Claude Code + login, sandbox, unit
  sudo salu runner setup [--user U] [--no-harden]
                                              install the systemd units (once per box); U runs the orchestrators.
                                              The units confine the service (read-only system, empty home, only its
                                              own project folder); --no-harden drops that if bubblewrap fails under it
  sudo salu runner add <project> [--clone git-url | --path folder] [--auth subscription|api-key]
                                              [--token-file F | --api-key-file F] [--no-sandbox] [--concurrency N]
                                              [--remote git-url | --no-sync]
                                              create the project's own salu home, register the project
                                              (sandbox ON unless --no-sandbox), start it now and on every boot.
                                              Also runs \`salu remote sync --watch\` as salu-sync@<project>, so tickets
                                              arrive and results leave over the project's git remote (--remote: the
                                              url, default the --clone url; --no-sync: orchestrator only)
  salu runner list                            every runner project: service state, queued / running tickets
  sudo salu runner start|stop|restart <project>
  salu runner logs <project> [--follow]       the orchestrator's log (journalctl)
  sudo salu runner remove <project> [--purge] [--yes]   stop and disable it; --purge also deletes its data

Each project gets its own folder /var/lib/salu/<project> (its database, log and kernel), its own
service salu-runner@<project> and its own git sync service salu-sync@<project>; a crashed or rebooted box brings every orchestrator back, and tickets a
dead run left running go back to the queue and resume their Claude session.

Subscription: run \`claude setup-token\` on any machine with a browser (Pro, Max, Team or Enterprise plan; a one-year
token Anthropic documents for scripts), then  --token-file <file>  (or CLAUDE_CODE_OAUTH_TOKEN in the environment).
API key instead:  --auth api-key --api-key-file <file>.
The token or key is stored in /etc/salu/<project>.env (root-readable, never on a command line). Workers do get it in
their environment and can reach any URL by default: use a key with a spend limit.`;

const dry = (p: Parsed) => flagBool(p, 'dry-run');
const systemctl = () => process.env.SALU_SYSTEMCTL || 'systemctl';
// With SALU_SYSTEMCTL pointing at a fake (tests) nothing needs root.
const needRoot = () => !process.env.SALU_SYSTEMCTL && process.getuid?.() !== 0;

function sh(p: Parsed, cmd: string[], opts: { input?: string; inherit?: boolean } = {}): { ok: boolean; out: string } {
  if (dry(p)) {
    console.log(dim(`$ ${cmd.join(' ')}`));
    return { ok: true, out: '' };
  }
  const r = spawnSync(cmd[0]!, cmd.slice(1), { encoding: 'utf8', input: opts.input, stdio: opts.inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'] });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

function mustRoot(what: string): void {
  if (needRoot()) throw new CliError(`${what} needs root: run it with sudo`);
}

/** The Linux user the orchestrators run as: --user, else the user who ran sudo, else the current user (or "salu" for root). */
function runnerUser(p: Parsed): { name: string; home: string } {
  const name = flagStr(p, 'user') ?? (process.env.SALU_RUNNER_USER || process.env.SUDO_USER) ?? (userInfo().username === 'root' ? 'salu' : userInfo().username);
  if (!/^[a-z_][a-z0-9_-]*$/.test(name)) throw new CliError(`"${name}" is not a valid user name`);
  const r = spawnSync('getent', ['passwd', name], { encoding: 'utf8' });
  const home = r.status === 0 ? r.stdout.split(':')[5] : '';
  return { name, home: home || (name === 'root' ? '/root' : `/home/${name}`) };
}

function unitPath(): string {
  return join(unitDir(), UNIT_NAME);
}
function syncUnitPath(): string {
  return join(unitDir(), SYNC_UNIT_NAME);
}

/** Does this salu have `salu remote` (git sync)? Older builds do not; then the runner works without sync. */
function hasRemote(): boolean {
  const r = spawnSync(selfCommand(['remote', '--help'])[0]!, selfCommand(['remote', '--help']).slice(1), { encoding: 'utf8' });
  return r.status === 0 && /salu remote/.test(r.stdout ?? '');
}

/** Services of one project: the orchestrator, plus the sync when it was set up. */
function servicesOf(name: string): string[] {
  let sync = false;
  try {
    sync = /^SALU_RUNNER_SYNC=1$/m.test(readFileSync(runnerEnvFile(name), 'utf8'));
  } catch {
    /* no env file */
  }
  return sync ? [serviceName(name), syncServiceName(name)] : [serviceName(name)];
}

/** User recorded in the installed unit (so `add` and the unit agree). */
function installedUser(): string | null {
  try {
    return /^User=(.+)$/m.exec(readFileSync(unitPath(), 'utf8'))?.[1] ?? null;
  } catch {
    return null;
  }
}

function setup(p: Parsed): number {
  if (!dry(p)) mustRoot('salu runner setup');
  const user = runnerUser(p);
  const bin = flagStr(p, 'bin') ?? selfCommand([])[0]!;
  if (!dry(p) && !needRoot() && user.name !== userInfo().username && spawnSync('id', [user.name]).status !== 0) {
    const mk = sh(p, ['useradd', '--create-home', '--shell', '/bin/bash', user.name]);
    if (!mk.ok) throw new CliError(`could not create the user ${user.name}: ${mk.out}`);
    console.log(`${green('✓')} created user ${user.name}`);
  }
  const uo = { bin, user: user.name, home: user.home, root: runnerRoot(), etc: runnerEtc(), harden: !flagBool(p, 'no-harden') };
  const text = renderUnit(uo);
  if (dry(p)) console.log(text + '\n' + renderSyncUnit(uo));
  else {
    mkdirSync(dirname(unitPath()), { recursive: true });
    writeFileSync(unitPath(), text);
    writeFileSync(syncUnitPath(), renderSyncUnit(uo));
    mkdirSync(runnerRoot(), { recursive: true });
    mkdirSync(runnerEtc(), { recursive: true, mode: 0o755 });
  }
  const r = sh(p, [systemctl(), 'daemon-reload']);
  if (!r.ok) throw new CliError(`systemctl daemon-reload failed: ${r.out}`);
  console.log(`${green('✓')} installed ${unitPath()} ${dim(`(runs as ${user.name}, binary ${bin})`)}`);
  console.log(dim(`next: log in once as ${user.name} (run \`claude\`, then /login), then \`sudo salu runner add <project> --clone <git-url>\``));
  return 0;
}

function add(p: Parsed): number {
  const name = requireRunnerName(p.positional[1]);
  if (!dry(p)) mustRoot('salu runner add');
  if (!existsSync(unitPath()) && !dry(p)) setup(p);
  const user = installedUser() ?? runnerUser(p).name;
  const home = runnerHome(name);
  if (!dry(p) && existsSync(join(home, 'tickets.db'))) throw new CliError(`runner project "${name}" already exists (${home}); salu runner remove ${name} --purge first`);

  const auth = (flagStr(p, 'auth') ?? (flagStr(p, 'api-key-file') ? 'api-key' : 'subscription')) as AuthMode;
  if (auth !== 'subscription' && auth !== 'api-key') throw new CliError('--auth is subscription or api-key');
  let apiKey: string | undefined;
  if (auth === 'api-key') {
    const f = flagStr(p, 'api-key-file');
    if (f) apiKey = readFileSync(f, 'utf8').trim();
    else if (process.env.ANTHROPIC_API_KEY) apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey && !dry(p)) throw new CliError('--auth api-key needs the key: --api-key-file <file> (or ANTHROPIC_API_KEY in the environment)');
  }
  let oauthToken: string | undefined;
  if (auth === 'subscription') {
    const tf = flagStr(p, 'token-file');
    oauthToken = tf ? readFileSync(tf, 'utf8').trim() : process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim() || undefined;
    if (tf && !oauthToken) throw new CliError(`${tf} is empty: put the token \`claude setup-token\` printed in it`);
    console.error(oauthToken ? SETUP_TOKEN_WARNING : NO_TOKEN_WARNING);
  }
  const sandbox = !flagBool(p, 'no-sandbox') && p.flags.sandbox !== false;
  if (sandbox) {
    const s = sandboxSupport();
    if (!s.ok) throw new CliError(`the sandbox is on by default on the runner and cannot run here: ${s.problem}\n(or pass --no-sandbox to run without it)`);
  }

  // Dirs first (as root), then the salu project itself as the runner user, so its files and any git credentials are that user's.
  if (!dry(p)) {
    mkdirSync(home, { recursive: true });
    sh(p, ['chown', `${user}:`, home]);
  }
  const clone = flagStr(p, 'clone');
  const path = flagStr(p, 'path') ?? runnerWork(name);
  const args = ['add', 'project', name, '--path', path];
  if (clone) args.push('--clone', clone);
  if (sandbox) args.push('--sandbox');
  const conc = flagStr(p, 'concurrency');
  if (conc) args.push('--concurrency', conc);
  const asUser = process.getuid?.() === 0 && user !== 'root' ? ['runuser', '-u', user, '--', 'env', `SALU_HOME=${home}`] : ['env', `SALU_HOME=${home}`];
  const made = sh(p, [...asUser, ...selfCommand(args)]);
  if (!made.ok) throw new CliError(`could not register the project:\n${made.out}`);
  if (made.out) console.log(made.out);

  const envPath = runnerEnvFile(name);
  // Git sync: on when this salu has `salu remote` and the project has a git url to exchange through.
  let sync = false;
  const remoteUrl = flagStr(p, 'remote') ?? clone;
  if (!flagBool(p, 'no-sync')) {
    if (!hasRemote()) console.log(dim('· git sync is not in this salu build yet, so only the orchestrator was set up (update salu, then `salu runner add` again)'));
    else {
      const rargs = ['remote', 'add', name, ...(remoteUrl ? [remoteUrl] : []), '--box'];
      const rr = sh(p, [...asUser, ...selfCommand(rargs)]);
      if (rr.ok) sync = true;
      else if (flagStr(p, 'remote')) {
        if (!dry(p)) rmSync(home, { recursive: true, force: true }); // leave nothing half-made, so the retry is clean
        throw new CliError(`could not set up git sync:\n${rr.out}`);
      }
      else console.log(dim(`· no git sync: ${rr.out.split('\n')[0]}\n  (give the project's git url with --remote <url> or --clone, or pass --no-sync)`));
    }
  }
  const text = renderEnvFile({ auth, apiKey: apiKey ?? (dry(p) ? 'dry-run' : undefined), oauthToken, sandbox, sync });
  if (!dry(p)) {
    mkdirSync(dirname(envPath), { recursive: true });
    writeFileSync(envPath, text, { mode: 0o600 });
    chmodSync(envPath, 0o600);
  }
  const en = sh(p, [systemctl(), 'enable', '--now', serviceName(name), ...(sync ? [syncServiceName(name)] : [])]);
  if (!en.ok) throw new CliError(`systemctl enable failed: ${en.out}`);
  console.log(`${green('✓')} runner ${name} ${dim(`started (${auth}, sandbox ${sandbox ? 'on' : 'off'}, git sync ${sync ? 'on' : 'off'}); home ${home}; \`salu runner logs ${name}\`)`)}`);
  return 0;
}

function control(p: Parsed, verb: 'start' | 'stop' | 'restart'): number {
  const name = requireRunnerName(p.positional[1]);
  if (!dry(p)) mustRoot(`salu runner ${verb}`);
  const r = sh(p, [systemctl(), verb, ...servicesOf(name)]);
  if (!r.ok) throw new CliError(`systemctl ${verb} ${name} failed: ${r.out}`);
  console.log(`${green('✓')} ${verb === 'stop' ? 'stopped' : verb === 'start' ? 'started' : 'restarted'} ${name}`);
  return 0;
}

function logs(p: Parsed): number {
  const name = requireRunnerName(p.positional[1]);
  const args = [...servicesOf(name).flatMap((u) => ['-u', u]), '--no-pager', '-n', flagStr(p, 'lines') ?? '100'];
  if (flagBool(p, 'follow')) args.push('-f');
  const r = spawnSync(process.env.SALU_JOURNALCTL || 'journalctl', args, { stdio: 'inherit' });
  return r.status ?? 1;
}

function remove(p: Parsed): Promise<number> | number {
  const name = requireRunnerName(p.positional[1]);
  if (!dry(p)) mustRoot('salu runner remove');
  const purge = flagBool(p, 'purge');
  const go = async () => {
    if (!dry(p) && !(await confirm(p, purge ? `stop ${name} and DELETE its tickets, logs and kernel (${runnerHome(name)})?` : `stop and disable ${name} (its data stays)?`))) {
      console.log(dim('left as it was'));
      return 0;
    }
    sh(p, [systemctl(), 'disable', '--now', ...servicesOf(name)]);
    if (purge && !dry(p)) {
      rmSync(runnerHome(name), { recursive: true, force: true });
      rmSync(runnerEnvFile(name), { force: true });
    }
    console.log(`${green('✓')} removed runner ${name}${purge ? ' and its data' : dim(' (data kept; --purge deletes it)')}`);
    return 0;
  };
  return go();
}

/** service state + ticket counts from the project's own database. */
async function list(p: Parsed): Promise<number> {
  const root = runnerRoot();
  const names: string[] = [];
  try {
    for (const e of (await import('node:fs')).readdirSync(root, { withFileTypes: true })) if (e.isDirectory() && existsSync(join(root, e.name, 'tickets.db'))) names.push(e.name);
  } catch {
    /* no root yet */
  }
  if (!names.length) {
    console.log(dim('no runner projects yet: sudo salu runner add <project> --clone <git-url>'));
    return 0;
  }
  const rows = [];
  for (const n of names.sort()) {
    const st = sh({ ...p, flags: { ...p.flags, 'dry-run': false } }, [systemctl(), 'is-active', serviceName(n)]).out || 'unknown';
    const counts = ticketCounts(runnerHome(n));
    const sv = servicesOf(n).length > 1 ? sh({ ...p, flags: { ...p.flags, 'dry-run': false } }, [systemctl(), 'is-active', syncServiceName(n)]).out || 'unknown' : null;
    rows.push({ project: n, service: st, sync: sv, ...counts });
  }
  if (flagBool(p, 'json')) {
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }
  for (const r of rows) {
    const mark = r.service === 'active' ? green('●') : red('●');
    console.log(`${mark} ${r.project}  ${r.service}  ${dim(`sync ${r.sync ?? 'off'} · ${r.todo} queued · ${r.running} running · ${r.blocked} blocked · ${r.done} done`)}`);
  }
  return 0;
}

function ticketCounts(home: string): { todo: number; running: number; blocked: number; done: number } {
  const { Database } = require('bun:sqlite') as typeof import('bun:sqlite');
  const out = { todo: 0, running: 0, blocked: 0, done: 0 };
  try {
    const db = new Database(join(home, 'tickets.db'), { readonly: true });
    for (const r of db.query<{ status: string; c: number }, []>('SELECT status, COUNT(*) AS c FROM tickets GROUP BY status').all()) {
      if (r.status === 'todo' || r.status === 'paused') out.todo += r.c;
      else if (r.status === 'running') out.running += r.c;
      else if (r.status === 'blocked') out.blocked += r.c;
      else if (r.status === 'done') out.done += r.c;
    }
    db.close();
  } catch {
    /* unreadable: leave zeros */
  }
  return out;
}

function doctor(): number {
  const linux = process.platform === 'linux';
  const claude = checkClaude().ok;
  const systemd = linux && existsSync('/run/systemd/system');
  const problems = boxProblems({
    linux,
    systemd: systemd || !!process.env.SALU_SYSTEMCTL,
    root: process.getuid?.() === 0,
    claude,
    sandbox: sandboxSupport(),
    unitInstalled: existsSync(unitPath()),
  });
  if (!problems.length) {
    console.log(`${green('✓')} this box is ready: \`sudo salu runner add <project> --clone <git-url>\``);
    return 0;
  }
  for (const m of problems) console.log(`${red('✗')} ${m}`);
  return 1;
}

export async function runner(p: Parsed): Promise<number> {
  const sub = p.positional[0];
  if (!sub || sub === 'help' || flagBool(p, 'help')) {
    console.log(HELP);
    return 0;
  }
  switch (sub) {
    case 'setup': return setup(p);
    case 'add': return add(p);
    case 'list': case 'ls': return list(p);
    case 'start': case 'stop': case 'restart': return control(p, sub);
    case 'logs': case 'log': return logs(p);
    case 'remove': case 'rm': return remove(p);
    case 'doctor': return doctor();
    default: throw new CliError(`unknown runner command "${sub}"\n\n${HELP}`);
  }
}
