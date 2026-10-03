import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, appendFileSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { CliError } from './errors.ts';
import { projectSocketDir } from './egress.ts';
import { requireSeatAuth, seatKey } from './seats.ts';
import { folderSlug } from './resolve.ts';
import { ticketHome } from './paths.ts';
import { kernelAuthMode, placeholderEnv } from './apiproxy.ts';

/**
 * The container kernel: one rootless Podman container per project, run with gVisor (`runsc`) when it is
 * installed. The kernel folder is the only thing from the host mounted in (at /work); the container has no
 * network of its own, only the egress filter's socket; Claude Code runs inside it with permission prompts off,
 * because the container is the boundary. Installs (apt, npm -g, pip) land in the container and persist for the
 * project. The orchestrator, database, sync and the phone stay on the host.
 */

export const WORKDIR = '/work';
const EGRESS_IN = '/run/salu/egress.sock';
const EGRESS_DIR_IN = '/run/salu';
/** Bumped when what a container mounts changes, so containers made the old way are recreated. */
const MOUNTS_VERSION = '3';

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

/** A seat's tickets run in a container of their own (prefix salu-ks-, so it can never be a project's default container). */
export function containerName(project: string, seat?: string | null): string {
  if (seat) return `salu-ks-${seatKey(project, seat)}${homeTag()}`;
  return `salu-k-${folderSlug(project)}${homeTag()}`;
}

/** Nothing for the usual ~/.salu; a short hash of SALU_HOME otherwise, so two homes with a project of the same name never share a container. */
export function homeTag(): string {
  return process.env.SALU_HOME ? `-${createHash('sha256').update(ticketHome()).digest('hex').slice(0, 6)}` : '';
}

export interface CreateOpts {
  name: string;
  project: string;
  /** the seat this container belongs to; its socket folder holds only that seat's login proxy */
  seat?: string | null;
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
    '--cap-drop', 'ALL', '--cap-add', 'CHOWN,DAC_OVERRIDE,FOWNER,FSETID,KILL,SETGID,SETUID,SETPCAP,SETFCAP,SYS_CHROOT,AUDIT_WRITE',
    '--memory', o.memory ?? process.env.SALU_KERNEL_MEMORY ?? '4g', '--cpus', o.cpus ?? process.env.SALU_KERNEL_CPUS ?? '2', '--pids-limit', String(o.pids ?? 2048),
    '--ulimit', 'nofile=4096:8192', '--shm-size', '256m',
    ...(o.disk ? ['--storage-opt', `size=${o.disk}`] : []),
    '--hostname', 'salu-kernel', '--workdir', WORKDIR,
    '--label', 'salu.kernel=1', '--label', `salu.project=${o.project}`, ...(o.seat ? ['--label', `salu.seat=${o.seat}`] : []), '--label', `salu.home=${ticketHome()}`, '--label', `salu.mounts=${MOUNTS_VERSION}`, '--label', `salu.image=${o.image ?? KERNEL_IMAGE}`,
    '-v', `${o.dir}:${WORKDIR}:rw`,
    // The socket's folder, not the socket file: a file mount keeps the inode it had at create time, and the filter
    // makes a new socket (new inode) every time it starts, which would leave a running container talking to a dead one.
    // This per-project socket folder is the ONLY host path (and so the only host unix socket) mounted into the
    // container; that is what keeps gVisor's `--host-uds=open` (see install-kernel-runtime.sh) scoped to this
    // project's egress/login socket. Do not add another host socket to these mounts without revisiting that.
    '-v', `${dirname(o.socket ?? join(projectSocketDir(o.project, o.seat), 'egress.sock'))}:${EGRESS_DIR_IN}:rw`,
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
  return process.env.SALU_KERNEL_TOKEN_FILE || join(ticketHome(), 'kernel-token');
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

/** What goes into the container for the login: the token itself (env mode) or only a placeholder (socket mode). */
export function containerAuthEnv(auth: Record<string, string>, mode = kernelAuthMode()): Record<string, string> {
  return mode === 'socket' ? placeholderEnv(auth) : auth;
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

/** Podman is started from the user's home, never the caller's cwd, which may be a folder this user cannot enter (sudo -u salu from /home/oliver). */
export const podmanCwd = () => process.env.HOME || homedir();
const podman = (bin: string, args: string[], input?: string) => spawnSync(bin, args, { encoding: 'utf8', input, timeout: 120000, cwd: podmanCwd() });

export function imageExists(bin: string, image = KERNEL_IMAGE): boolean {
  return podman(bin, ['image', 'exists', image]).status === 0;
}

/** Make sure the project's container exists and runs; create it from the image the first time. */
export function ensureContainer(project: string, dir: string, bin = engine(), onStart?: (t: StartTiming) => void, seat?: string | null): string {
  const t0 = performance.now();
  if (!bin) throw new CliError('Podman was not found. Install the container runtime: sudo scripts/install-kernel-runtime.sh (Linux) or brew install podman (Mac), then salu kernel setup.');
  const name = containerName(project, seat);
  const inspect = () => {
    const r = podman(bin, ['inspect', '--format', '{{.State.Status}} {{index .Config.Labels "salu.mounts"}} {{index .Config.Labels "salu.image"}}', name]);
    const [status = '', mounts = '', image = ''] = (r.stdout ?? '').trim().split(/\s+/);
    return { status: r.status, text: status, mounts, image };
  };
  let state = inspect();
  for (let i = 0; i < 20 && state.text === 'stopping'; i++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); // an idle stop is finishing; start only after it
    state = inspect();
  }
  if (state.status === 0 && (state.mounts !== MOUNTS_VERSION || state.image !== KERNEL_IMAGE)) {
    podman(bin, ['rm', '-f', name]); // made before the egress socket folder was mounted, or from an older image: recreate it
    state = { status: 1, text: '', mounts: '', image: '' };
  }
  const created = state.status !== 0;
  if (state.status !== 0) {
    if (!imageExists(bin)) throw new CliError(`the kernel image ${KERNEL_IMAGE} is not built yet: run \`salu kernel setup\``);
    const rt = runtime();
    const disk = `${kernelDiskGb()}g`;
    let c = podman(bin, createArgs({ name, project, seat, dir, runtime: rt.name, disk }));
    // The size limit needs a storage backend that can enforce it (overlay on xfs with project quotas); without one,
    // drop --storage-opt and fall back to the per-project checkDisk guard. Say so once, so an operator knows the hard
    // per-container cap is off on this box rather than assuming it holds.
    if (c.status !== 0 && /storage-opt|quota|size/i.test(c.stderr + c.stdout)) {
      process.stderr.write(`salu kernel: this storage backend cannot enforce a ${disk} per-container disk cap; relying on the ${kernelDiskGb()} GB per-project folder check instead. For a hard cap, put the podman storage on xfs with project quotas.\n`);
      c = podman(bin, createArgs({ name, project, seat, dir, runtime: rt.name, disk: null }));
    }
    if (c.status !== 0) throw new CliError(`could not create the kernel container: ${(c.stderr || c.stdout).trim().split('\n').pop()}`);
  }
  if (state.text !== 'running') {
    const s = podman(bin, ['start', name]);
    if (s.status !== 0) throw new CliError(`could not start the kernel container: ${(s.stderr || s.stdout).trim().split('\n').pop()}`);
    onStart?.(recordStart({ project, ms: Math.round(performance.now() - t0), kind: created ? 'created' : 'started' }));
  }
  return name;
}

// ---- Unloading idle containers ---------------------------------------------------------------------------

export interface StartTiming {
  ts: number;
  project: string;
  ms: number;
  kind: 'created' | 'started';
  platform: string;
}

/** Where each container start is logged, one JSON line each, so the first runs on a box give real numbers. */
export function startsLog(): string {
  return join(ticketHome(), 'logs', 'kernel-starts.jsonl');
}

export function recordStart(t: Omit<StartTiming, 'ts' | 'platform'>, file = startsLog()): StartTiming {
  const full: StartTiming = { ts: Date.now(), platform: gvisorPlatform() ?? (runtime().gvisor ? 'systrap' : 'host'), ...t };
  try {
    mkdirSync(join(file, '..'), { recursive: true });
    appendFileSync(file, JSON.stringify(full) + '\n');
  } catch {
    /* a log must not break a ticket */
  }
  return full;
}

/** Median and worst of the logged starts, for `salu kernel`. */
export function startStats(file = startsLog()): { count: number; medianMs: number; maxMs: number } | null {
  try {
    const ms = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => (JSON.parse(l) as StartTiming).ms).sort((a, b) => a - b);
    return ms.length ? { count: ms.length, medianMs: ms[Math.floor(ms.length / 2)]!, maxMs: ms[ms.length - 1]! } : null;
  } catch {
    return null;
  }
}

/**
 * Minutes a project's container stays loaded after its last ticket ends: SALU_KERNEL_IDLE_MINUTES, default 5.
 * 0 stops it as soon as the last ticket ends; `never` keeps containers running. Stopped containers keep
 * their files and installed packages on disk and start again with the next ticket (also ends background
 * processes an agent left running).
 */
export function idleMinutes(env: NodeJS.ProcessEnv = process.env): number | null {
  const v = (env.SALU_KERNEL_IDLE_MINUTES ?? '').trim().toLowerCase();
  if (v === 'never') return null;
  const n = Number(v);
  return v !== '' && Number.isFinite(n) && n >= 0 ? n : 5;
}

const inUse = new Map<string, number>();
const stopTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Count a running ticket against the project's container; the returned function lets go of it. */
export function holdContainer(project: string, bin: string, o: { env?: NodeJS.ProcessEnv; stop?: (bin: string, name: string) => void; seat?: string | null } = {}): () => void {
  const name = containerName(project, o.seat);
  clearTimeout(stopTimers.get(name));
  stopTimers.delete(name);
  inUse.set(name, (inUse.get(name) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (inUse.get(name) ?? 1) - 1;
    if (left > 0) return void inUse.set(name, left);
    inUse.delete(name);
    const mins = idleMinutes(o.env);
    if (mins === null) return;
    const stop = o.stop ?? ((b, n) => void spawn(b, ['stop', '-t', '5', n], { stdio: 'ignore' }).unref());
    const run = () => {
      stopTimers.delete(name);
      if (!inUse.has(name)) stop(bin, name);
    };
    if (mins === 0) run();
    else stopTimers.set(name, setTimeout(run, mins * 60000).unref());
  };
}

/** Stop salu's containers that nothing here is using: leftovers from a crashed or restarted orchestrator. */
export function sweepStaleContainers(bin: string): void {
  // only this home's containers: other orchestrators on the box (one per project) are using theirs
  const r = podman(bin, ['ps', '--filter', 'label=salu.kernel=1', '--filter', `label=salu.home=${ticketHome()}`, '--format', '{{.Names}}']);
  for (const n of (r.stdout ?? '').split('\n').map((x) => x.trim()).filter(Boolean)) if (!inUse.has(n) && !n.startsWith('salu-k-doctor')) podman(bin, ['stop', '-t', '5', n]);
}

/**
 * The SDK's `spawnClaudeCodeProcess`: run `claude` inside the project's container instead of on this machine.
 * Environment goes in through a 0600 file that is deleted right after the process starts, never on a command line.
 * Only Claude's own variables and the proxy settings go in: nothing from this machine's environment.
 */
export function containerSpawner(project: string, dir: string, o: { bin?: string; auth?: Record<string, string>; seat?: string | null; onStderr?: (s: string) => void } = {}): (opts: SpawnOptions) => SpawnedProcess {
  return (opts) => {
    const bin = o.bin ?? engine();
    const auth = o.auth ?? (o.seat ? requireSeatAuth(o.seat) : requireKernelAuth()); // before anything starts: no login, no run (a seat never falls back to another login)
    const name = ensureContainer(project, dir, bin, (t) => o.onStderr?.(`salu kernel: container ${t.kind} in ${(t.ms / 1000).toFixed(1)} s (${t.platform})`), o.seat);
    const release = holdContainer(project, bin!, { seat: o.seat });
    const keep = /^(CLAUDE_|ANTHROPIC_|SALU_TICKET|SALU_KERNEL_WORKER|LANG$|LC_|TERM$)/;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts.env)) if (v !== undefined && keep.test(k) && !CREDENTIAL_ENV.test(k)) env[k] = v;
    Object.assign(env, containerAuthEnv(auth));
    const tmp = mkdtempSync(join(tmpdir(), 'salu-env-'));
    const file = join(tmp, 'env');
    writeFileSync(file, Object.entries(env).map(([k, v]) => `${k}=${v.replace(/\n/g, ' ')}`).join('\n') + '\n', { mode: 0o600 });
    const child = spawn(bin!, execArgs(name, file, ['claude', ...opts.args.filter((a, i) => !(i === 0 && /^\/.*\.[cm]?js$/.test(a)))]), { stdio: ['pipe', 'pipe', 'pipe'], cwd: podmanCwd(), signal: opts.signal, env: { PATH: process.env.PATH, HOME: process.env.HOME, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } });
    child.stderr!.on('data', (d: Buffer) => o.onStderr?.(d.toString()));
    const clean = () => rmSync(tmp, { recursive: true, force: true });
    child.once('spawn', () => setTimeout(clean, 2000)); // the exec client has read the file by then
    child.once('error', clean);
    child.once('error', release);
    child.once('exit', release);
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
      sqlite3 libsqlite3-dev libssl-dev nodejs npm sudo vim-tiny procps bubblewrap \\
    && rm -rf /var/lib/apt/lists/*
# Agent commands run inside bubblewrap's one-id user namespace (the token scrub), where apt cannot switch to its
# _apt download user (setgroups/setegid fail), and root there has no rights over files the unmapped _apt owns.
# Download as the container's root instead (gVisor confines that root) into a root-owned partial folder.
RUN printf 'APT::Sandbox::User "root";\\n' > /etc/apt/apt.conf.d/99salu-sandbox-user && chown root:root /var/cache/apt/archives/partial
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash && npm install -g @anthropic-ai/claude-code
RUN printf '#!/bin/sh\\nsocat TCP-LISTEN:3128,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:${EGRESS_IN} >/tmp/salu-init.log 2>&1 &\\nexec sleep infinity\\n' > /usr/local/bin/salu-kernel-init && chmod +x /usr/local/bin/salu-kernel-init
WORKDIR ${WORKDIR}
ENTRYPOINT ["/usr/local/bin/salu-kernel-init"]
`;

/** The image is tagged with a hash of what it is built from, so a changed Containerfile is a new image, built once, and containers made from the old one are recreated. SALU_KERNEL_IMAGE overrides it. */
export const KERNEL_IMAGE_REPO = 'localhost/salu-kernel';
export const KERNEL_IMAGE_VERSION = createHash('sha256').update(DOCKERFILE).digest('hex').slice(0, 10);
export const KERNEL_IMAGE = process.env.SALU_KERNEL_IMAGE || `${KERNEL_IMAGE_REPO}:${KERNEL_IMAGE_VERSION}`;

export function buildImage(bin: string, log: (l: string) => void = () => {}): void {
  const dir = mkdtempSync(join(tmpdir(), 'salu-image-'));
  try {
    writeFileSync(join(dir, 'Containerfile'), DOCKERFILE);
    const r = spawnSync(bin, ['build', '-t', KERNEL_IMAGE, '-f', join(dir, 'Containerfile'), dir], { stdio: ['ignore', 'inherit', 'inherit'], cwd: podmanCwd() });
    if (r.status !== 0) throw new CliError('building the kernel image failed (see the output above)');
    log(`built ${KERNEL_IMAGE}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface EnsureImageResult {
  built: boolean;
  /** containers removed because they were made from another image (they start again from this one with the next ticket) */
  recycled: string[];
  /** older salu-kernel images removed to free disk */
  pruned: number;
}

/** Build the kernel image only when the current version is missing (or `force`), then recycle containers and drop images of other versions. Safe to run again. */
export function ensureImage(bin: string, o: { force?: boolean; log?: (l: string) => void } = {}): EnsureImageResult {
  const log = o.log ?? (() => {});
  const built = o.force || !imageExists(bin);
  if (built) buildImage(bin, log);
  else log(`image ${KERNEL_IMAGE} is current`);
  const recycled: string[] = [];
  const list = podman(bin, ['ps', '-a', '--filter', 'label=salu.kernel=1', '--format', '{{.Names}} {{index .Labels "salu.image"}}']);
  for (const line of (list.stdout ?? '').split('\n')) {
    const [name, image = ''] = line.trim().split(/\s+/);
    if (name && image !== KERNEL_IMAGE && podman(bin, ['rm', '-f', name]).status === 0) recycled.push(name);
  }
  let pruned = 0;
  if (!process.env.SALU_KERNEL_IMAGE) {
    const imgs = podman(bin, ['images', '--format', '{{.Repository}}:{{.Tag}}', KERNEL_IMAGE_REPO]);
    for (const img of (imgs.stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean)) {
      if (img !== KERNEL_IMAGE && podman(bin, ['rmi', img]).status === 0) pruned++;
    }
  }
  return { built, recycled, pruned };
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
  // (start timings and idle setting are shown by `salu kernel` through startStats and idleMinutes)
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

// ---- box-wide slots -----------------------------------------------------------------------------------------

/**
 * The box runs one orchestrator per project, each with its own SALU_HOME, so the memory-based default cannot be
 * counted per orchestrator. Running container tickets are counted box-wide with one small file per ticket in a
 * folder under the real home (shared by all `salu@<project>` units, like Podman's own storage): `<pid>-<ticket>`.
 * Files whose process is gone are ignored and removed.
 */
export function boxSlotsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.SALU_BOX_SLOTS_DIR || join(env.HOME || homedir(), '.local', 'state', 'salu', 'slots');
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM';
  }
}

/** Container tickets running on this box right now, across all orchestrators, and how many of them started in the last `youngMs`. */
export function boxSlots(dir = boxSlotsDir(), youngMs = 60_000, now = Date.now()): { running: number; young: number } {
  let running = 0;
  let young = 0;
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return { running, young };
  }
  for (const f of names) {
    const pid = Number(f.split('-')[0]);
    if (!Number.isInteger(pid) || !pidAlive(pid)) {
      rmSync(join(dir, f), { force: true });
      continue;
    }
    running++;
    try {
      if (now - statSync(join(dir, f)).mtimeMs < youngMs) young++;
    } catch {
      /* gone meanwhile */
    }
  }
  return { running, young };
}

export function boxRunning(dir = boxSlotsDir()): number {
  return boxSlots(dir).running;
}

/** Take a slot for a ticket (the caller checked `boxRunning` against the cap first). */
export function takeBoxSlot(ticketId: number | string, dir = boxSlotsDir()): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    writeFileSync(join(dir, `${process.pid}-${ticketId}`), '');
  } catch {
    /* counting is best effort */
  }
}

export function releaseBoxSlot(ticketId: number | string, dir = boxSlotsDir()): void {
  rmSync(join(dir, `${process.pid}-${ticketId}`), { force: true });
}

/**
 * The most tickets the box runs at once: SALU_BOX_CONCURRENCY, else one per 1.5 GiB beyond the 3 GiB kept for
 * the system, the egress filter and Podman (16 GB gives 8), at most 8. The containers' 4 GB limits are ceilings,
 * not what a ticket usually uses, so memory is checked live before each start (`boxAdmit`) instead of reserved.
 */
export function boxConcurrency(totalBytes: number, env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.SALU_BOX_CONCURRENCY);
  if (Number.isInteger(n) && n > 0) return n;
  return Math.max(1, Math.min(8, Math.floor((totalBytes - 3 * GIB) / (1.5 * GIB))));
}

/** MemAvailable in bytes from /proc/meminfo, or null. */
export function memAvailable(text?: string): number | null {
  try {
    const m = /^MemAvailable:\s+(\d+) kB/m.exec(text ?? readFileSync('/proc/meminfo', 'utf8'));
    return m ? Number(m[1]) * 1024 : null;
  } catch {
    return null;
  }
}

/** The 10-second "some" memory stall percentage from /proc/pressure/memory (PSI), or null when the kernel has none. */
export function memoryPressure(text?: string): number | null {
  try {
    const m = /^some .*avg10=([\d.]+)/m.exec(text ?? readFileSync('/proc/pressure/memory', 'utf8'));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

export type Admission = { ok: boolean; reason: string | null; running: number; limit: number };

/**
 * May another container ticket start right now? One always may. Otherwise: under the box ceiling, no memory
 * pressure (PSI some avg10 below SALU_BOX_PSI, default 10), and the free memory left after counting what a new
 * ticket (and each one started in the last minute, which is still growing) is expected to take stays above a
 * margin. Typical footprint SALU_BOX_TICKET_MEMORY (default 1g), margin SALU_BOX_MEMORY_MARGIN (default 3g).
 */
export function boxAdmit(o: { dir?: string; total?: number; available?: number | null; pressure?: number | null; env?: NodeJS.ProcessEnv; now?: number } = {}): Admission {
  const env = o.env ?? process.env;
  const total = o.total ?? totalmem();
  const limit = boxConcurrency(total, env);
  const { running, young } = boxSlots(o.dir ?? boxSlotsDir(env), 60_000, o.now);
  const no = (reason: string): Admission => ({ ok: false, reason, running, limit });
  if (running >= limit) return no(`${running} of ${limit} tickets already running on this box`);
  if (running === 0) return { ok: true, reason: null, running, limit };
  const psiMax = Number(env.SALU_BOX_PSI ?? 10);
  const pressure = o.pressure === undefined ? memoryPressure() : o.pressure;
  if (pressure != null && pressure >= psiMax) return no(`memory pressure ${pressure.toFixed(1)}% (limit ${psiMax}%)`);
  const typical = parseMemory(env.SALU_BOX_TICKET_MEMORY ?? '1g') ?? GIB;
  const margin = parseMemory(env.SALU_BOX_MEMORY_MARGIN ?? '3g') ?? 3 * GIB;
  const avail = o.available === undefined ? memAvailable() : o.available;
  if (avail != null) {
    const left = avail - (young + 1) * typical;
    if (left < margin) return no(`only ${(avail / GIB).toFixed(1)} GiB of memory free with ${young} ticket${young === 1 ? '' : 's'} still starting (keeping ${(margin / GIB).toFixed(1)} GiB spare)`);
  }
  return { ok: true, reason: null, running, limit };
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
