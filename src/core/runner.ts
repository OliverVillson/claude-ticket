/**
 * Headless runner (the always-on Linux box): one orchestrator process per project, each under
 * systemd, each with its own salu home (its own database, log, kernel and heartbeat).
 *
 *   <root>/<project>/            SALU_HOME of that project's orchestrator   (root: /var/lib/salu)
 *   <root>/<project>/work/       the project's folder when salu cloned or created it
 *   <etc>/<project>.env          credentials and settings, root-only        (etc: /etc/salu)
 *   /etc/systemd/system/salu-runner@.service   one template, instance name = project
 *
 * Nothing here touches the machine: it computes paths and renders files, so it can be tested anywhere.
 */
import { join } from 'node:path';
import { CliError } from './errors.ts';

export const UNIT_NAME = 'salu-runner@.service';
export const SYNC_UNIT_NAME = 'salu-sync@.service';
export const UNIT_DIR = '/etc/systemd/system';

export function runnerRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.SALU_RUNNER_ROOT || '/var/lib/salu';
}
export function runnerEtc(env: NodeJS.ProcessEnv = process.env): string {
  return env.SALU_RUNNER_ETC || '/etc/salu';
}
export function unitDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.SALU_RUNNER_UNIT_DIR || UNIT_DIR;
}

/** Project names double as systemd instance names and folder names, so keep them boring. */
export function validRunnerName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(name);
}
export function requireRunnerName(name: string | undefined): string {
  if (!name) throw new CliError('name the project: salu runner <command> <project>');
  if (!validRunnerName(name)) throw new CliError(`"${name}" cannot be a runner project name: use lowercase letters, digits, - and _ (it becomes a systemd instance and a folder name)`);
  return name;
}

export const runnerHome = (name: string, env?: NodeJS.ProcessEnv) => join(runnerRoot(env), name);
export const runnerWork = (name: string, env?: NodeJS.ProcessEnv) => join(runnerHome(name, env), 'work');
export const runnerEnvFile = (name: string, env?: NodeJS.ProcessEnv) => join(runnerEtc(env), `${name}.env`);
export const serviceName = (name: string) => `salu-runner@${name}.service`;
export const syncServiceName = (name: string) => `salu-sync@${name}.service`;

export interface UnitOptions {
  /** Absolute path of the salu binary the unit runs. */
  bin: string;
  /** Linux user the orchestrators (and their Claude login) run as. */
  user: string;
  /** That user's home directory (where ~/.claude holds the login). */
  home: string;
  root: string;
  etc: string;
  /** Add the sandboxing directives below (default true). `salu runner setup --no-harden` turns them off. */
  harden?: boolean;
}

/**
 * Directives that confine the service itself, in case the worker sandbox is off or escaped. The worker
 * runs as the same Linux user as the orchestrator, so without these it could read every other project
 * and the shared Claude login. With them the process sees: a read-only system, an empty home holding only
 * what this service needs, and only its own project's folder under the runner root.
 *
 *  orchestrator  its project folder (rw), the Claude login ~/.claude + ~/.claude.json (rw: sessions and token
 *                refresh), the Claude install under ~/.local (ro). No ssh keys, no git credentials.
 *  sync          its project folder (rw), git credentials ~/.ssh ~/.gitconfig ~/.config/git. No Claude login.
 *
 * Deliberately NOT set, because they break the worker sandbox's bubblewrap (it needs user namespaces,
 * a mountable /proc, netlink for its network namespace) or Bun's JIT: RestrictNamespaces, SystemCallFilter,
 * ProtectKernelTunables, ProtectProc/ProcSubset, PrivateDevices, MemoryDenyWriteExecute.
 */
export function hardening(o: UnitOptions, kind: 'orchestrator' | 'sync'): string {
  if (o.harden === false) return '';
  for (const v of [o.home, o.root]) if (/\s/.test(v)) throw new CliError(`cannot harden a unit with whitespace in a path: ${v}`);
  const h = o.home;
  const binds =
    kind === 'orchestrator'
      ? { rw: [`${h}/.claude`, `${h}/.claude.json`], ro: [`${h}/.local/bin`, `${h}/.local/share/claude`] }
      : { rw: [`${h}/.ssh`], ro: [`${h}/.gitconfig`, `${h}/.config/git`] };
  return `
# Confinement of the service itself (see hardening() in src/core/runner.ts).
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=tmpfs
TemporaryFileSystem=${o.root}:ro
BindPaths=${o.root}/%i ${binds.rw.map((x) => '-' + x).join(' ')}
ReadWritePaths=${o.root}/%i ${binds.rw.map((x) => '-' + x).join(' ')}
BindReadOnlyPaths=${binds.ro.map((x) => '-' + x).join(' ')}
PrivateTmp=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
LockPersonality=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
CapabilityBoundingSet=
AmbientCapabilities=
RemoveIPC=yes
UMask=0077
`;
}

/**
 * The systemd template. Restart=always brings a crashed orchestrator back and WantedBy makes it
 * start on boot; on start the orchestrator puts tickets a dead run left `running` back in the queue
 * (they resume their Claude session). KillMode=control-group takes every worker process down with
 * the orchestrator, so nothing is left running unsupervised. --no-queue: a restart must not queue
 * the backlog, only pick up what was already queued.
 */
export function renderUnit(o: UnitOptions): string {
  return `# Managed by \`salu runner\`; regenerated by \`salu runner setup\`.
[Unit]
Description=salu orchestrator for %i
Documentation=https://github.com/OliverVillson/salu
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=${o.user}
WorkingDirectory=${o.root}/%i
Environment=SALU_HOME=${o.root}/%i
Environment=HOME=${o.home}
Environment=PATH=${o.home}/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=SALU_AUTH=subscription
EnvironmentFile=-${o.etc}/%i.env
ExecStart=${o.bin} run --plain --no-queue %i
Restart=always
# 78 = this machine cannot work (Claude logged out, login expired or key rejected). A crash or a login that
# broke mid-run restarts (a fresh process re-reads the credentials); a login that is still dead at start
# exits 78 and stays failed, visible in \`salu runner list\`, until \`salu runner restart <project>\`.
RestartPreventExitStatus=78
RestartSec=15
KillMode=control-group
TimeoutStopSec=45
${hardening(o, 'orchestrator')}
[Install]
WantedBy=multi-user.target
`;
}

/**
 * The git-sync companion of the orchestrator (`salu remote sync --watch`): it fetches tickets that
 * arrive on the project's salu/inbox branch into the project's database and pushes messages and result
 * branches back, so tickets reach the box and results leave it. Same home, user and credentials as the
 * orchestrator; supervised the same way. Git credentials come from the runner user's own git setup.
 */
export function renderSyncUnit(o: UnitOptions): string {
  return `# Managed by \`salu runner\`; regenerated by \`salu runner setup\`.
[Unit]
Description=salu git sync for %i
Documentation=https://github.com/OliverVillson/salu
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=${o.user}
WorkingDirectory=${o.root}/%i
Environment=SALU_HOME=${o.root}/%i
Environment=HOME=${o.home}
Environment=PATH=${o.home}/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=GIT_TERMINAL_PROMPT=0
ExecStart=${o.bin} remote sync --watch
Restart=always
RestartSec=15
KillMode=control-group
${hardening(o, 'sync')}
[Install]
WantedBy=multi-user.target
`;
}

/** Shown by `salu runner add --auth subscription`. Sources are secondhand; the wording stays a question, not a verdict. */
export const SUBSCRIPTION_WARNING =
  'warning: --auth subscription runs Claude on this box with a Pro/Max login. Anthropic\'s terms may not allow a ' +
  'subscription login in other tools or for automated, unattended use (an API key is the supported route for that), ' +
  'and long headless sessions can lose their login until restarted. Check the current terms before relying on it; ' +
  'to switch: --auth api-key --api-key-file <file>.';

export type AuthMode = 'subscription' | 'api-key';

/** Contents of /etc/salu/<project>.env. The key lives only here, root-readable. */
export function renderEnvFile(o: { auth: AuthMode; apiKey?: string; sandbox: boolean; sync?: boolean }): string {
  const lines = ['# salu runner settings for one project (root-only; edit, then `salu runner restart <project>`)', `SALU_AUTH=${o.auth}`];
  if (o.auth === 'api-key') {
    if (!o.apiKey) throw new CliError('SALU_AUTH=api-key needs a key');
    if (/[\s"'\\$]/.test(o.apiKey)) throw new CliError('that API key has characters an env file cannot hold safely');
    lines.push(`ANTHROPIC_API_KEY=${o.apiKey}`);
  }
  if (!o.sandbox) lines.push('SALU_SANDBOX=off');
  // Read back by `salu runner` (start/stop/list/remove) to know the project also has a sync service; the orchestrator ignores it.
  if (o.sync) lines.push('SALU_RUNNER_SYNC=1');
  return lines.join('\n') + '\n';
}

/** What `salu runner doctor` needs to know about the box; filled in by the command. */
export interface BoxFacts {
  linux: boolean;
  systemd: boolean;
  root: boolean;
  claude: boolean;
  sandbox: { ok: boolean; problem?: string };
  unitInstalled: boolean;
}

export function boxProblems(f: BoxFacts): string[] {
  const out: string[] = [];
  if (!f.linux) out.push('the runner is for Linux boxes (this is not Linux); on a Mac just use `salu run`');
  if (f.linux && !f.systemd) out.push('systemd is not running here; the runner needs it for restart and boot start');
  if (!f.claude) out.push('Claude Code is not installed: curl -fsSL https://claude.ai/install.sh | bash, then run `claude` once and /login');
  if (!f.sandbox.ok) out.push(`the sandbox cannot run (${f.sandbox.problem}); runner projects have it on by default`);
  if (!f.unitInstalled) out.push('the systemd unit is not installed: sudo salu runner setup');
  return out;
}
