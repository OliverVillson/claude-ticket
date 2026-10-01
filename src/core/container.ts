import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
 * What the container's Claude Code logs in with. A dedicated token (`claude setup-token`, saved with
 * `salu kernel login`) in ~/.salu/kernel-token, or the variables already set. It lives inside the container,
 * so treat it as revocable: it is not your main login. (A later phase keeps it on the host instead.)
 */
export function claudeAuthEnv(env: NodeJS.ProcessEnv = process.env, file = tokenFile()): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX']) if (env[k]) out[k] = env[k]!;
  if (!out.CLAUDE_CODE_OAUTH_TOKEN && !out.ANTHROPIC_API_KEY && !out.ANTHROPIC_AUTH_TOKEN && existsSync(file)) {
    const t = readFileSync(file, 'utf8').trim();
    if (t) out.CLAUDE_CODE_OAUTH_TOKEN = t;
  }
  return out;
}

export function saveToken(token: string, file = tokenFile()): void {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, token.trim() + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
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
    const c = podman(bin, createArgs({ name, project, dir, runtime: rt.name }));
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
    const name = ensureContainer(project, dir, bin);
    const keep = /^(CLAUDE_|ANTHROPIC_|CLAUDE$|SALU_TICKET|SALU_KERNEL_WORKER|LANG$|LC_|TERM$)/;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts.env)) if (v !== undefined && keep.test(k)) env[k] = v;
    Object.assign(env, o.auth ?? claudeAuthEnv());
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
  if (!Object.keys(auth).length) problems.push('agents have no Claude login: run `claude setup-token`, then `salu kernel login`');
  if (bin && !rt.gvisor) problems.push('gVisor (runsc) is not installed, so containers share the host kernel directly (weaker): sudo scripts/install-kernel-runtime.sh');
  return { engine: bin, runtime: rt.name ?? 'default', gvisor: rt.gvisor, image, token: Object.keys(auth).length > 0, problems };
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
