import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { HookCallback, Options } from '@anthropic-ai/claude-agent-sdk';
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

let ttyCheck: () => boolean = () => !!process.stdin.isTTY && !!process.stdout.isTTY;
/** For tests only: replace the terminal check. Agents cannot call this; they only run shell commands. */
export function setHumanTty(fn: (() => boolean) | null): void {
  ttyCheck = fn ?? (() => !!process.stdin.isTTY && !!process.stdout.isTTY);
}

/**
 * salu push/export are for a person at a terminal. Two checks: the worker marker (a hint, a worker can
 * clear it), and a real terminal on stdin and stdout, which a worker's shell does not have.
 * The real barrier is the OS sandbox: a sandboxed shell cannot write outside the kernel or read your logins.
 */
export function requireHuman(what: string): void {
  if (insideWorker() || !ttyCheck()) throw new CliError(`salu ${what} is for you, not for agents: run it yourself, from an interactive terminal.`);
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

/** Extra belt-and-braces deny rules for secret paths; the real fence is the allow-list in fileToolGuard. */
export function secretPaths(home = homedir()): string[] {
  return ['.ssh', '.aws', '.gnupg', '.config/gh', '.config/git', '.config/gcloud', '.config/op', '.azure', '.gitconfig', '.git-credentials', '.netrc', '.npmrc', '.pgpass', '.my.cnf', '.docker', '.kube', '.terraform.d', '.bash_history', '.zsh_history', '.zshenv', '.zshrc', '.bashrc', '.profile', '.salu/tickets.db', '.salu/logs', '.claude/.credentials.json', '.claude/settings.json', '.claude.json']
    .map((p) => join(home, p));
}

/**
 * Environment allow-list: a worker gets what it needs to run and to log in to Claude, nothing else.
 * (A deny-list of "secret-looking" names always misses one: DATABASE_URL, STRIPE_SECRET_KEY, ...)
 * SALU_ENV_PASS=NAME,OTHER adds variables you want workers to have.
 */
const ENV_ALLOW = /^(PATH|HOME|USER|LOGNAME|SHELL|TERM|COLORTERM|NO_COLOR|FORCE_COLOR|LANG|LANGUAGE|LC_.*|TZ|TMPDIR|PWD|CI|EDITOR|VISUAL|XDG_.*|HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy|ALL_PROXY|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|CURL_CA_BUNDLE|REQUESTS_CA_BUNDLE|ANTHROPIC_.*|CLAUDE_.*|SALU_.*|BUN_.*)$/;

export function scrubSecrets(env: Record<string, string | undefined>, pass: string[] = (process.env.SALU_ENV_PASS ?? '').split(',').map((x) => x.trim()).filter(Boolean)): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) if (ENV_ALLOW.test(k) || pass.includes(k)) out[k] = v;
  out.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = '1'; // ask Claude Code to strip its own credentials from the commands it runs
  return out;
}

/** Real path of `p`, following symlinks in the part that exists (so a link inside the kernel cannot lead out). */
function canon(p: string, cwd: string, home: string): string {
  const expanded = p === '~' ? home : p.startsWith('~/') ? join(home, p.slice(2)) : p;
  let cur = resolve(isAbsolute(expanded) ? expanded : join(cwd, expanded));
  const rest: string[] = [];
  for (let guard = 0; guard < 64; guard++) {
    try {
      return join(realpathSync(cur), ...rest.reverse());
    } catch {
      const up = dirname(cur);
      if (up === cur) break;
      rest.push(cur.slice(up.length).replace(/^[/\\]/, ''));
      cur = up;
    }
  }
  return resolve(p);
}

const within = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);
const SYSTEM_READ = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/opt', '/nix', '/System', '/Library', '/Applications', '/etc/ssl', '/etc/os-release', '/etc/alternatives', '/private/etc/ssl', '/dev/null', '/dev/urandom'];

/** Paths inside the kernel that a worker can read but never change: they run code or change settings later. */
function protectedInKernel(rel: string): boolean {
  return /^(\.git\/(hooks|config)(\/|$)|\.claude(\/|$)|\.mcp\.json$|\.gitconfig$|\.gitmodules$)/.test(rel);
}

/** Big command output is saved by Claude Code under ~/.claude/projects/<project>/<session>/tool-results and read back with Read. */
const toolResult = (real: string, home: string) => within(real, join(home, '.claude', 'projects')) && /\/tool-results\/[^/]+$/.test(real);

const PATH_FIELDS = ['file_path', 'notebook_path', 'path', 'directory'];

/**
 * The fence for the file tools (Read, Edit, Write, NotebookEdit, Glob, Grep), which the OS sandbox does
 * not cover. An allow-list on real paths: writes only inside the kernel folder (and temp), reads only
 * the kernel, temp, runtime folders and system libraries. Returns the reason to refuse, or null.
 */
export function fileToolGuard(dir: string, o: { home?: string; tmp?: string } = {}): (tool: string, input: unknown) => string | null {
  const home = o.home ?? homedir();
  const kernel = canon(dir, dir, home);
  const tmps = [...new Set((o.tmp ? [o.tmp] : [process.env.TMPDIR ?? tmpdir(), '/tmp', '/private/tmp']).map((t) => canon(t, kernel, home)))];
  const readable = [kernel, ...tmps, ...toolDirs(home).map((d) => canon(d, kernel, home)), ...SYSTEM_READ];
  return (tool, input) => {
    if (!input || typeof input !== 'object') return null;
    const inp = input as Record<string, unknown>;
    const writes = tool !== 'Read' && tool !== 'Glob' && tool !== 'Grep' && tool !== 'LS' && tool !== 'NotebookRead';
    const paths: string[] = [];
    for (const f of PATH_FIELDS) if (typeof inp[f] === 'string') paths.push(inp[f] as string);
    // Search patterns can climb out with `..` or start at the root.
    for (const f of ['pattern', 'glob']) {
      const v = inp[f];
      if ((tool === 'Glob' || (tool === 'Grep' && f === 'glob')) && typeof v === 'string' && (isAbsolute(v) || v.startsWith('~') || v.split(/[\\/]/).includes('..'))) return `${tool} pattern "${v}" leaves the kernel folder`;
    }
    for (const raw of paths) {
      const real = canon(raw, kernel, home);
      if (writes) {
        const ok = within(real, kernel) ? !protectedInKernel(real.slice(kernel.length + 1)) : tmps.some((t) => within(real, t));
        if (!ok) return `${tool} may only change files inside the kernel folder ${kernel} (not ${real})`;
      } else if (!readable.some((r) => within(real, r)) && !toolResult(real, home)) {
        return `${tool} may only read inside the kernel folder ${kernel} (not ${real})`;
      }
    }
    return null;
  };
}

/** The SDK hook that applies fileToolGuard to every tool call, denying on any error. */
export function fileToolHook(dir: string, o: { home?: string; tmp?: string } = {}): HookCallback {
  const guard = fileToolGuard(dir, o);
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    let reason: string | null;
    try {
      reason = guard(input.tool_name, input.tool_input);
    } catch (e: any) {
      reason = `could not check ${input.tool_name}: ${e?.message ?? e}`;
    }
    return reason ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `salu kernel: ${reason}` } } : {};
  };
}

/** Tool directories under home that shell commands still need to read (compilers, runtimes). */
function toolDirs(home: string): string[] {
  return ['.bun', '.nvm', '.volta', '.cargo', '.rustup', '.pyenv', '.rbenv', '.asdf', '.local/bin', '.local/share/pnpm', '.deno', 'go']
    .map((d) => join(home, d)).filter((d) => existsSync(d));
}

export interface KernelOptions {
  sandbox: NonNullable<Options['sandbox']>;
  disallowedTools: string[];
  hooks: NonNullable<Options['hooks']>;
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
      filesystem: { allowWrite: [dir], denyRead: [...new Set([home, kernelRoot()])], allowRead: [dir, ...toolDirs(home)] },
      network: { allowedDomains: allowedDomains(o.env), strictAllowlist: allowedDomains(o.env)[0] !== '*' },
    },
    disallowedTools: secrets.flatMap((p) => ['Read', 'Edit', 'Write'].flatMap((t) => [`${t}(${p})`, `${t}(${p}/**)`])),
    hooks: { PreToolUse: [{ hooks: [fileToolHook(dir, { home })] }] },
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
