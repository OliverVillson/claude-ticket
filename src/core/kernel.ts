import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { CliError } from './errors.ts';
import { folderSlug } from './resolve.ts';
import { ticketHome } from './paths.ts';

/**
 * The kernel: a sandbox for workers. Each project gets its own copy of the code under
 * ~/.salu/kernel/<project> (a `git clone --local` when the project is a git repo, else a plain copy).
 * Workers run there, and their shell commands run inside Claude Code's OS sandbox (Seatbelt on macOS,
 * bubblewrap on Linux): they may write only in their kernel folder, cannot read the home folder or
 * credentials, and reach only a list of domains. Nothing gets back to the real project until you run
 * `salu push` or `salu export`, which workers cannot run.
 *
 * SALU_SANDBOX=off turns it off (workers then run in the project folder as before).
 */

export function sandboxOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return !['off', '0', 'no', 'false'].includes((env.SALU_SANDBOX ?? '').toLowerCase());
}

export function kernelRoot(): string {
  return process.env.SALU_KERNEL || join(ticketHome(), 'kernel');
}

export function kernelPath(projectName: string): string {
  return join(kernelRoot(), folderSlug(projectName));
}

/** Set on every worker; salu push/export refuse to run when they see it. */
export function insideWorker(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SALU_KERNEL_WORKER === '1';
}

export function requireHuman(what: string): void {
  if (insideWorker()) throw new CliError(`salu ${what} is for you, not for agents. Run it from your own terminal.`);
}

const sh = (cwd: string, ...args: string[]) => Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });

export function isGitRepo(dir: string): boolean {
  return existsSync(join(dir, '.git'));
}

/** Create the kernel copy of a project the first time it is needed; later runs reuse it. */
export function prepareKernel(projectName: string, projectPath: string): string {
  const dir = kernelPath(projectName);
  if (existsSync(dir)) return dir;
  if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) throw new CliError(`project folder ${projectPath} does not exist, so there is nothing to copy into the kernel`);
  mkdirSync(kernelRoot(), { recursive: true });
  if (isGitRepo(projectPath)) {
    const r = Bun.spawnSync(['git', 'clone', '--local', '--no-hardlinks', '--', projectPath, dir], { stdout: 'pipe', stderr: 'pipe' });
    if (r.exitCode !== 0) throw new CliError(`could not copy ${projectPath} into the kernel: ${r.stderr.toString().trim().split('\n').pop()}`);
    // A working tree with uncommitted changes is copied over the clone so agents start from what you see.
    if (sh(projectPath, 'status', '--porcelain').stdout.toString().trim()) copyTree(projectPath, dir, { skipGit: true });
  } else {
    copyTree(projectPath, dir, { skipGit: false });
    sh(dir, 'init', '-q');
  }
  return dir;
}

export function copyTree(from: string, to: string, o: { skipGit: boolean }): void {
  cpSync(from, to, { recursive: true, filter: (src) => !(o.skipGit && (src === join(from, '.git') || src.startsWith(join(from, '.git') + '/'))) });
}

/** Where a project's code came from: the origin URL of the real project, if it has one. */
export function originUrl(projectPath: string): string | null {
  if (!isGitRepo(projectPath)) return null;
  const r = sh(projectPath, 'remote', 'get-url', 'origin');
  return r.exitCode === 0 ? r.stdout.toString().trim() || null : null;
}

/** Agents may reach any site. SALU_SANDBOX_DOMAINS=a.com,*.b.com limits them to that list instead. */
export function allowedDomains(env: NodeJS.ProcessEnv = process.env): string[] {
  const list = (env.SALU_SANDBOX_DOMAINS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  return list.length ? list : ['*'];
}

/** Places an agent's Read tool must never open (the OS sandbox only covers shell commands). */
export function secretPaths(home = homedir()): string[] {
  return ['.ssh', '.aws', '.gnupg', '.config/gh', '.config/git', '.gitconfig', '.git-credentials', '.netrc', '.npmrc', '.docker', '.kube', '.salu/tickets.db', '.salu/logs', '.claude/.credentials.json', '.claude.json']
    .map((p) => join(home, p));
}

/** Variables that carry git or cloud logins; workers never get them. Claude's own auth variables are kept. */
const SECRET_ENV = /^(GITHUB_TOKEN|GH_TOKEN|GH_ENTERPRISE_TOKEN|GITLAB_TOKEN|NPM_TOKEN|NODE_AUTH_TOKEN|SSH_AUTH_SOCK|GIT_ASKPASS|SSH_ASKPASS|AWS_.*|GOOGLE_APPLICATION_CREDENTIALS|AZURE_.*|DOCKER_.*|HF_TOKEN|OPENAI_API_KEY)$/;

export function scrubSecrets(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) if (!SECRET_ENV.test(k)) out[k] = v;
  return out;
}

/** Tool directories under home that shell commands still need to read (compilers, runtimes). */
function toolDirs(home: string): string[] {
  return ['.bun', '.nvm', '.volta', '.cargo', '.rustup', '.pyenv', '.rbenv', '.asdf', '.local/bin', '.local/share/pnpm', '.deno', 'go']
    .map((d) => join(home, d)).filter((d) => existsSync(d));
}

export interface KernelOptions {
  sandbox: NonNullable<Options['sandbox']>;
  disallowedTools: string[];
}

/** The SDK settings that put a worker in the kernel folder `dir`. */
export function kernelOptions(dir: string, o: { home?: string; env?: NodeJS.ProcessEnv } = {}): KernelOptions {
  const home = o.home ?? homedir();
  const secrets = secretPaths(home);
  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: true, // a sandbox that cannot start stops the ticket instead of running unprotected
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      filesystem: { allowWrite: [dir], denyRead: [home], allowRead: [dir, ...toolDirs(home)] },
      network: { allowedDomains: allowedDomains(o.env), strictAllowlist: allowedDomains(o.env)[0] !== '*' },
    },
    disallowedTools: secrets.flatMap((p) => [`Read(${p})`, `Read(${p}/**)`, `Edit(${p})`, `Edit(${p}/**)`]),
  };
}

/** What `salu doctor` needs to know: can the OS sandbox run here? */
export function sandboxSupport(platform = process.platform, which: (c: string) => string | null = (c) => Bun.which(c)): { ok: boolean; problem?: string } {
  if (platform === 'darwin') return { ok: true };
  if (platform === 'linux') {
    const missing = ['bwrap', 'socat'].filter((c) => !which(c));
    return missing.length ? { ok: false, problem: `install ${missing.map((c) => (c === 'bwrap' ? 'bubblewrap' : c)).join(' and ')} (e.g. sudo apt-get install bubblewrap socat)` } : { ok: true };
  }
  return { ok: false, problem: 'the sandbox supports macOS, Linux and WSL2 only; set SALU_SANDBOX=off to run without it' };
}

export function listBranches(dir: string): string[] {
  return sh(dir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').stdout.toString().split('\n').filter(Boolean);
}

export function isEmptyDir(dir: string): boolean {
  return !existsSync(dir) || readdirSync(dir).length === 0;
}

export const resolvePath = resolve;
