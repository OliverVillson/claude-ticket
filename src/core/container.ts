import { spawn, spawnSync } from 'node:child_process';
import { accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { CliError } from './errors.ts';
import { egressSocketPath } from './egress.ts';
import { folderSlug } from './resolve.ts';
import { ticketHome } from './paths.ts';

/**
 * The container kernel: one rootless Podman container per project, run with gVisor (`runsc`) when it is
 * installed. The kernel folder is the only thing from the host mounted in (at /work); the container has no
 * network of its own, only the egress filter's socket; Claude Code runs inside it with permission prompts off,
 * because the container is the boundary. Installs (apt, npm -g, pip) land in the container and persist for the
 * project. The orchestrator, database, sync and the phone stay on the host.
 */

export const KERNEL_IMAGE = process.env.SALU_KERNEL_IMAGE || 'localhost/salu-kernel:1';
export const WORKDIR = '/work';
const EGRESS_IN = '/run/salu/egress.sock';

export const containerOn = (env: NodeJS.ProcessEnv = process.env) => !['off', '0', 'no', 'false'].includes((env.SALU_CONTAINER ?? '').toLowerCase());

/** The container engine: rootless Podman only (a Docker daemon runs as root, which is a bigger prize for an escape). */
export function engine(env: NodeJS.ProcessEnv = process.env, which: (c: string) => string | null = (c) => Bun.which(c)): string | null {
  return env.SALU_CONTAINER_ENGINE || which('podman');
}

/** gVisor when present (or asked for with SALU_CONTAINER_RUNTIME), else the engine's default runtime. */
export function runtime(env: NodeJS.ProcessEnv = process.env, which: (c: string) => string | null = (c) => Bun.which(c)): { name: string | null; gvisor: boolean } {
  const want = env.SALU_CONTAINER_RUNTIME;
  if (want) return { name: want, gvisor: want === 'runsc' };
  return which('runsc') ? { name: 'runsc', gvisor: true } : { name: null, gvisor: false };
}

export function containerName(project: string): string {
  return `salu-k-${folderSlug(project)}`;
}

export interface CreateOpts {
  name: string;
  project: string;
  dir: string;
  runtime?: string | null;
  socket?: string;
  image?: string;
  memory?: string;
  cpus?: string;
  pids?: number;
  /** container layer size limit, e.g. 20g; left off when the storage backend cannot enforce it */
  disk?: string | null;
}

/** `podman create` arguments for a project's kernel container. */
export function createArgs(o: CreateOpts): string[] {
  const env: Record<string, string> = {
    HTTP_PROXY: 'http://127.0.0.1:3128', HTTPS_PROXY: 'http://127.0.0.1:3128', http_proxy: 'http://127.0.0.1:3128', https_proxy: 'http://127.0.0.1:3128',
    NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1', IS_SANDBOX: '1', HOME: '/root',
  };
  return [
    'create', '--name', o.name,
    ...(o.runtime ? ['--runtime', o.runtime] : []),
    '--network', 'none', // the only way out is the egress socket below
    '--security-opt', 'no-new-privileges',
    '--cap-drop', 'ALL', '--cap-add', 'CHOWN,DAC_OVERRIDE,FOWNER,FSETID,KILL,SETGID,SETUID,SETPCAP,SYS_CHROOT,AUDIT_WRITE',
    '--memory', o.memory ?? process.env.SALU_KERNEL_MEMORY ?? '4g', '--cpus', o.cpus ?? process.env.SALU_KERNEL_CPUS ?? '2', '--pids-limit', String(o.pids ?? 2048),
    '--ulimit', 'nofile=4096:8192', '--shm-size', '256m',
    ...(o.disk ? ['--storage-opt', `size=${o.disk}`] : []),
    '--hostname', 'salu-kernel', '--workdir', WORKDIR,
    '--label', 'salu.kernel=1', '--label', `salu.project=${o.project}`,
    '-v', `${o.dir}:${WORKDIR}:rw`,
    '-v', `${o.socket ?? egressSocketPath()}:${EGRESS_IN}:rw`,
    ...Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`]),
    o.image ?? KERNEL_IMAGE,
  ];
}

/** `podman exec` arguments that run a command in the project's container. */
export function execArgs(name: string, envFile: string, cmd: string[]): string[] {
  return ['exec', '-i', '--workdir', WORKDIR, '--env-file', envFile, name, ...cmd];
}

// ---- Claude credentials for the container --------------------------------------------------------------

export function tokenFile(): string {
  return join(ticketHome(), 'kernel-token');
}

/**
 * What the container's Claude Code logs in with: ONLY the dedicated token saved by `salu kernel login`
 * (~/.salu/kernel-token), never the orchestrator's own login. The box's main token sits in this process's
 * environment; an agent can send whatever it holds out over the egress filter, so the container only ever gets
 * a token you can revoke on its own. No kernel token means no container run (see requireKernelAuth).
 */
export function claudeAuthEnv(_env: NodeJS.ProcessEnv = process.env, file = tokenFile()): Record<string, string> {
  if (!existsSync(file)) return {};
  const t = readFileSync(file, 'utf8').trim();
  if (!t) return {};
  return /^sk-ant-api/.test(t) ? { ANTHROPIC_API_KEY: t } : { CLAUDE_CODE_OAUTH_TOKEN: t };
}

/** The container's login, or a refusal that says how to get one. Never falls back to the orchestrator's login. */
export function requireKernelAuth(file = tokenFile()): Record<string, string> {
  const auth = claudeAuthEnv(process.env, file);
  if (!Object.keys(auth).length) throw new CliError('the container has no login of its own: run `claude setup-token` and then `salu kernel login` (agents never get the login this machine runs on)');
  return auth;
}

/** Variables that carry a login or point Claude at another account/provider: never copied into the container from here. */
export const CREDENTIAL_ENV = /^(ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL|CUSTOM_HEADERS|BEDROCK_.*|VERTEX_.*|FOUNDRY_.*)|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_USE_.*|CLAUDE_CODE_SKIP_.*|AWS_.*|GOOGLE_.*|AZURE_.*|GITHUB_TOKEN|GH_TOKEN)$/;

export function saveToken(token: string, file = tokenFile()): void {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, token.trim() + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
}

// ---- Disk -----------------------------------------------------------------------------------------------

/** SALU_KERNEL_DISK_GB: most one project's kernel (its folder and its container) may hold. Default 20. */
export const kernelDiskGb = (env: NodeJS.ProcessEnv = process.env) => Math.max(1, Number(env.SALU_KERNEL_DISK_GB) || 20);

function dirBytes(dir: string): number {
  const r = spawnSync('du', ['-sk', '--apparent-size', dir], { encoding: 'utf8' });
  return r.status === 0 ? Number(r.stdout.split(/\s/)[0]) * 1024 : 0;
}

/** Refuse to start a ticket whose project is over its disk limit or when the box itself is nearly full. */
export function checkDisk(dir: string, o: { limitGb?: number; minFreeGb?: number; used?: (d: string) => number; free?: (d: string) => number } = {}): void {
  const limit = o.limitGb ?? kernelDiskGb();
  const used = (o.used ?? dirBytes)(dir);
  if (used > limit * 1e9) throw new CliError(`this project's kernel folder holds ${(used / 1e9).toFixed(1)} GB, over the ${limit} GB limit: clean it up (salu kernel shell) or raise SALU_KERNEL_DISK_GB`);
  const free = (o.free ?? ((d) => { const r = spawnSync('df', ['-Pk', d], { encoding: 'utf8' }); return Number(r.stdout.trim().split('\n').pop()?.split(/\s+/)[3]) * 1024; }))(dir);
  const min = o.minFreeGb ?? 5;
  if (Number.isFinite(free) && free < min * 1e9) throw new CliError(`only ${(free / 1e9).toFixed(1)} GB is free on this machine (needs ${min}): free some space before running more tickets`);
}

// ---- Running things -------------------------------------------------------------------------------------

const podman = (bin: string, args: string[], input?: string) => spawnSync(bin, args, { encoding: 'utf8', input, timeout: 120000 });

export function imageExists(bin: string, image = KERNEL_IMAGE): boolean {
  return podman(bin, ['image', 'exists', image]).status === 0;
}

/** Make sure the project's container exists and runs; create it from the image the first time. */
export function ensureContainer(project: string, dir: string, bin = engine()): string {
  if (!bin) throw new CliError('Podman was not found. Install the container runtime: sudo scripts/install-kernel-runtime.sh (Linux) or brew install podman (Mac), then salu kernel setup.');
  const name = containerName(project);
  const state = podman(bin, ['inspect', '--format', '{{.State.Status}}', name]);
  if (state.status !== 0) {
    if (!imageExists(bin)) throw new CliError(`the kernel image ${KERNEL_IMAGE} is not built yet: run \`salu kernel setup\``);
    const rt = runtime();
    const disk = `${kernelDiskGb()}g`;
    let c = podman(bin, createArgs({ name, project, dir, runtime: rt.name, disk }));
    // The size limit needs a storage backend that can enforce it (overlay on xfs with quotas); without one, the
    // per-ticket size check below is the limit.
    if (c.status !== 0 && /storage-opt|quota|size/i.test(c.stderr + c.stdout)) c = podman(bin, createArgs({ name, project, dir, runtime: rt.name, disk: null }));
    if (c.status !== 0) throw new CliError(`could not create the kernel container: ${(c.stderr || c.stdout).trim().split('\n').pop()}`);
  }
  if ((state.stdout ?? '').trim() !== 'running') {
    const s = podman(bin, ['start', name]);
    if (s.status !== 0) throw new CliError(`could not start the kernel container: ${(s.stderr || s.stdout).trim().split('\n').pop()}`);
  }
  return name;
}

/**
 * The SDK's `spawnClaudeCodeProcess`: run `claude` inside the project's container instead of on this machine.
 * Environment goes in through a 0600 file that is deleted right after the process starts, never on a command line.
 * Only Claude's own variables and the proxy settings go in: nothing from this machine's environment.
 */
export function containerSpawner(project: string, dir: string, o: { bin?: string; auth?: Record<string, string>; onStderr?: (s: string) => void } = {}): (opts: SpawnOptions) => SpawnedProcess {
  return (opts) => {
    const bin = o.bin ?? engine();
    const auth = o.auth ?? requireKernelAuth(); // before anything starts: no kernel login, no run
    const name = ensureContainer(project, dir, bin);
    const keep = /^(CLAUDE_|ANTHROPIC_|SALU_TICKET|SALU_KERNEL_WORKER|LANG$|LC_|TERM$)/;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts.env)) if (v !== undefined && keep.test(k) && !CREDENTIAL_ENV.test(k)) env[k] = v;
    Object.assign(env, auth);
    const tmp = mkdtempSync(join(tmpdir(), 'salu-env-'));
    const file = join(tmp, 'env');
    writeFileSync(file, Object.entries(env).map(([k, v]) => `${k}=${v.replace(/\n/g, ' ')}`).join('\n') + '\n', { mode: 0o600 });
    const child = spawn(bin!, execArgs(name, file, ['claude', ...opts.args.filter((a, i) => !(i === 0 && /^\/.*\.[cm]?js$/.test(a)))]), { stdio: ['pipe', 'pipe', 'pipe'], signal: opts.signal, env: { PATH: process.env.PATH, HOME: process.env.HOME, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } });
    child.stderr!.on('data', (d: Buffer) => o.onStderr?.(d.toString()));
    const clean = () => rmSync(tmp, { recursive: true, force: true });
    child.once('spawn', () => setTimeout(clean, 2000)); // the exec client has read the file by then
    child.once('error', clean);
    return child as unknown as SpawnedProcess;
  };
}

// ---- The image ------------------------------------------------------------------------------------------

/** What `salu kernel setup` builds. A large image on purpose: agents get the tools they need without installing them. */
export const DOCKERFILE = `FROM docker.io/library/ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8
RUN apt-get update && apt-get install -y --no-install-recommends \\
      ca-certificates curl wget git openssh-client socat unzip zip xz-utils jq ripgrep fd-find tree less file patch \\
      build-essential pkg-config cmake make python3 python3-pip python3-venv python3-dev golang-go default-jdk-headless \\
      sqlite3 libsqlite3-dev libssl-dev nodejs npm sudo vim-tiny procps \\
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash && npm install -g @anthropic-ai/claude-code
RUN printf '#!/bin/sh\\nsocat TCP-LISTEN:3128,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:${EGRESS_IN} &\\nexec sleep infinity\\n' > /usr/local/bin/salu-kernel-init && chmod +x /usr/local/bin/salu-kernel-init
WORKDIR ${WORKDIR}
ENTRYPOINT ["/usr/local/bin/salu-kernel-init"]
`;

export function buildImage(bin: string, log: (l: string) => void = () => {}): void {
  const dir = mkdtempSync(join(tmpdir(), 'salu-image-'));
  try {
    writeFileSync(join(dir, 'Containerfile'), DOCKERFILE);
    const r = spawnSync(bin, ['build', '-t', KERNEL_IMAGE, '-f', join(dir, 'Containerfile'), dir], { stdio: ['ignore', 'inherit', 'inherit'] });
    if (r.status !== 0) throw new CliError('building the kernel image failed (see the output above)');
    log(`built ${KERNEL_IMAGE}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface KernelStatus {
  engine: string | null;
  runtime: string;
  gvisor: boolean;
  image: boolean;
  token: boolean;
  /** will a ticket run in a container here, or silently in the fence? */
  mode: 'container' | 'fence' | 'refused';
  required: boolean;
  problems: string[];
}

export function kernelStatus(): KernelStatus {
  const bin = engine();
  const rt = runtime();
  const auth = claudeAuthEnv();
  const problems: string[] = [];
  if (!bin) problems.push('Podman is not installed (Linux: sudo scripts/install-kernel-runtime.sh; Mac: brew install podman)');
  const image = !!bin && imageExists(bin);
  if (bin && !image) problems.push('the kernel image is not built: salu kernel setup');
  if (!Object.keys(auth).length) problems.push('agents have no Claude login of their own: run `claude setup-token`, then `salu kernel login` (the login this machine runs on is never given to a container)');
  if (bin && !rt.gvisor) problems.push('gVisor (runsc) is not installed, so containers share the host kernel directly (weaker): sudo scripts/install-kernel-runtime.sh');
  const token = Object.keys(auth).length > 0;
  const ready = !!bin && image && containerOn() && process.platform === 'linux';
  const required = containerRequired();
  const mode = ready && token ? 'container' : required || ready ? 'refused' : 'fence';
  if (mode === 'fence') problems.push('tickets are running in the weaker fence on this machine, not in a container' + (process.platform === 'linux' ? ' (set SALU_KERNEL_REQUIRE=1 to refuse instead)' : ' (the container kernel is Linux only for now)'));
  return { engine: bin, runtime: rt.name ?? 'default', gvisor: rt.gvisor, image, token, mode, required, problems };
}

// ---- Is the container kernel usable here? ---------------------------------------------------------------

let readyCache: { at: number; ok: boolean } | null = null;

/**
 * True when workers can run in containers: Linux, Podman present, the image built. (Mac support is the next
 * step: the egress filter needs a different transport there.) Checked at most every 30 seconds.
 */
export function containerReady(o: { platform?: string; env?: NodeJS.ProcessEnv; fresh?: boolean } = {}): boolean {
  const env = o.env ?? process.env;
  if (!containerOn(env) || (o.platform ?? process.platform) !== 'linux') return false;
  if (!o.fresh && readyCache && Date.now() - readyCache.at < 30000) return readyCache.ok;
  const bin = engine(env);
  const ok = !!bin && imageExists(bin);
  readyCache = { at: Date.now(), ok };
  return ok;
}

export function resetContainerReadyCache(): void {
  readyCache = null;
}

/** SALU_KERNEL_REQUIRE=1: never fall back to the weaker fence; a ticket that cannot get a container fails. */
export const containerRequired = (env: NodeJS.ProcessEnv = process.env) => env.SALU_KERNEL_REQUIRE === '1';

// ---- How many tickets at once ----------------------------------------------------------------------------

/** "4g", "512m", "2048" (bytes) -> bytes; null when it is not a size. */
export function parseMemory(v: string | undefined): number | null {
  const m = (v ?? '').trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([kmgt]?)b?$/);
  if (!m) return null;
  return Math.floor(Number(m[1]) * { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }[m[2] as '' | 'k' | 'm' | 'g' | 't']);
}

const GIB = 1024 ** 3;

/**
 * How many containers this machine's memory can carry: what is left after 3 GiB for the system, the orchestrator
 * and the egress filter, divided by one container's memory limit (default 4g). 16 GB gives 3. At least 1, at most 8.
 * Only a default: `--concurrency`, `salu change`, the saved setting and SALU_CONCURRENCY all override it.
 */
export function memoryConcurrency(totalBytes: number, env: NodeJS.ProcessEnv = process.env): number {
  const per = parseMemory(env.SALU_KERNEL_MEMORY ?? '4g') ?? 4 * GIB;
  return Math.max(1, Math.min(8, Math.floor((totalBytes - 3 * GIB) / per)));
}

// ---- gVisor platform ---------------------------------------------------------------------------------------

export const GVISOR_PLATFORMS = ['systrap', 'kvm', 'ptrace'] as const;
export type GvisorPlatform = (typeof GVISOR_PLATFORMS)[number];

/** Where the runtime wrapper looks for the chosen platform (SALU_GVISOR_PLATFORM wins when set). */
export function platformFile(home = process.env.HOME ?? '', xdg = process.env.XDG_CONFIG_HOME): string {
  return join(xdg || join(home, '.config'), 'salu', 'gvisor-platform');
}

/** The platform gVisor will use for containers started from now on. Unset means gVisor's own default (systrap). */
export function gvisorPlatform(env: NodeJS.ProcessEnv = process.env, file = platformFile()): GvisorPlatform | null {
  const v = (env.SALU_GVISOR_PLATFORM || (existsSync(file) ? readFileSync(file, 'utf8') : '')).trim();
  return (GVISOR_PLATFORMS as readonly string[]).includes(v) ? (v as GvisorPlatform) : null;
}

export function setGvisorPlatform(p: GvisorPlatform | null, file = platformFile()): void {
  if (p === null) return void rmSync(file, { force: true });
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, p + '\n');
}

/** kvm needs /dev/kvm that this user can open (VT-x on in the BIOS, and the user in the kvm group). */
export function kvmUsable(): boolean {
  try {
    accessSync('/dev/kvm', constants.R_OK | constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
