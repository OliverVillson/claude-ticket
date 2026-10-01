import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
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

/**
 * How a worker is confined. `kernel`: a private copy of the project (project.sandbox). `fence`: the real
 * project folder, but file changes are fenced to it (the default for every project). `off`: no
 * confinement, only when you set SALU_SANDBOX=off yourself.
 */
export type Confinement = 'kernel' | 'fence' | 'off';

export function confinementFor(project: { sandbox?: number | boolean } | null | undefined, env: NodeJS.ProcessEnv = process.env): Confinement {
  if (!sandboxOn(env)) return 'off';
  return project?.sandbox ? 'kernel' : 'fence';
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
 * salu push/export are for a person at a terminal. These checks are guard rails, not a barrier: a worker
 * can clear the marker and can fake a terminal (`script`). What actually stops a worker is the OS sandbox
 * and the file-tool fence: it cannot write outside the kernel, read your git login, or push with your credentials.
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

/** The credential stores of secretPaths: what a fenced worker (working in the real project) may not read. Git identity and shell setup stay readable. */
export function credentialPaths(home = homedir()): string[] {
  return ['.ssh', '.aws', '.gnupg', '.config/gh', '.config/gcloud', '.config/op', '.azure', '.git-credentials', '.netrc', '.npmrc', '.pgpass', '.my.cnf', '.docker', '.kube', '.terraform.d', '.salu/tickets.db', '.salu/logs', '.claude/.credentials.json', '.claude.json']
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

/**
 * Real path of `p`: symlinks are followed in the part that exists, including a link whose target does not
 * exist yet (a dangling link is followed to where writing through it would land), and `..` is resolved.
 * A link loop or an unreadable link resolves to a path that no allow-list contains.
 */
function canon(p: string, cwd: string, home: string, depth = 0): string {
  if (depth > 40) return '/__salu_symlink_loop__';
  const expanded = p === '~' ? home : p.startsWith('~/') ? join(home, p.slice(2)) : p;
  let cur = resolve(isAbsolute(expanded) ? expanded : join(cwd, expanded));
  const rest: string[] = [];
  for (let guard = 0; guard < 4096; guard++) {
    try {
      return join(realpathSync(cur), ...rest.reverse());
    } catch {
      try {
        if (lstatSync(cur).isSymbolicLink()) {
          // exists as a link (dangling or looping): continue from where it points
          return canon(join(resolve(dirname(cur), readlinkSync(cur)), ...rest.reverse()), cwd, home, depth + 1);
        }
      } catch {
        /* does not exist at all: go up */
      }
      const up = dirname(cur);
      if (up === cur) break;
      rest.push(cur.slice(up.length).replace(/^[/\\]/, ''));
      cur = up;
    }
  }
  return '/__salu_unresolvable__';
}

const within = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);
const SYSTEM_READ = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/opt', '/nix', '/System', '/Library', '/Applications', '/etc/ssl', '/etc/os-release', '/etc/alternatives', '/private/etc/ssl', '/dev/null', '/dev/urandom'];

/** Paths inside the kernel that a worker can read but never change: they run code or change settings later. */
function protectedInKernel(rel: string): boolean {
  return /^(\.git\/(hooks|config)(\/|$)|\.claude(\/|$)|\.mcp\.json$|\.gitconfig$|\.gitmodules$)/.test(rel);
}

function multiplyLinked(real: string): boolean {
  try {
    const st = lstatSync(real);
    return st.isFile() && st.nlink > 1;
  } catch {
    return false; // does not exist (yet)
  }
}

/** Big command output is saved by Claude Code under ~/.claude/projects/<project>/<session>/tool-results and read back with Read. */
const toolResult = (real: string, home: string) => within(real, join(home, '.claude', 'projects')) && /\/tool-results\/[^/]+$/.test(real);

const PATH_FIELDS = ['file_path', 'notebook_path', 'path', 'directory'];

/**
 * The fence for the file tools (Read, Edit, Write, NotebookEdit, Glob, Grep), which the OS sandbox does
 * not cover. An allow-list on real paths: writes only inside the kernel folder (and temp), reads only
 * the kernel, temp, runtime folders and system libraries. Returns the reason to refuse, or null.
 */
export function fileToolGuard(dir: string, o: { home?: string; tmp?: string; fence?: boolean } = {}): (tool: string, input: unknown) => string | null {
  const home = o.home ?? homedir();
  // fence: the folder is the real project. Reads are open except credential stores; only writes are confined.
  const what = o.fence ? 'project' : 'kernel';
  const blockedReads = o.fence ? credentialPaths(home).map((p) => canon(p, dir, home)) : [];
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
      if (!o.fence && (tool === 'Glob' || (tool === 'Grep' && f === 'glob')) && typeof v === 'string' && (isAbsolute(v) || v.startsWith('~') || v.split(/[\\/]/).includes('..'))) return `${tool} pattern "${v}" leaves the ${what} folder`;
    }
    for (const raw of paths) {
      const real = canon(raw, kernel, home);
      if (writes) {
        const ok = within(real, kernel) ? !protectedInKernel(real.slice(kernel.length + 1)) : tmps.some((t) => within(real, t));
        if (!ok) return `${tool} may only change files inside the ${what} folder ${kernel} (not ${real})`;
      } else if (o.fence) {
        if (blockedReads.some((b) => within(real, b))) return `${tool} may not read credential files (${real})`;
      } else if (!readable.some((r) => within(real, r)) && !toolResult(real, home)) {
        return `${tool} may only read inside the kernel folder ${kernel} (not ${real})`;
      }
      // A hard link is another name for the same file, which may live outside the kernel (`ln ~/.ssh/id_rsa here`).
      if (multiplyLinked(real) && !within(real, join(kernel, '.git', 'objects'))) return `${tool} refused: ${real} has several hard links, so it may be the same file as one outside the kernel`;
    }
    return null;
  };
}

/** The SDK hook that applies fileToolGuard to every tool call, denying on any error. */
export function fileToolHook(dir: string, o: { home?: string; tmp?: string; fence?: boolean } = {}): HookCallback {
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

/**
 * The SDK settings that confine a worker working in `dir`. `kernel` (default): `dir` is the private copy; the
 * home folder is closed to reads. `fence`: `dir` is the real project; writes are confined to it just the same,
 * reads stay open except credential stores (git identity, tool caches and sibling folders keep working).
 */
export function kernelOptions(dir: string, o: { home?: string; env?: NodeJS.ProcessEnv; mode?: 'kernel' | 'fence' } = {}): KernelOptions {
  const home = o.home ?? homedir();
  const fence = o.mode === 'fence';
  const secrets = fence ? credentialPaths(home) : secretPaths(home);
  const domains = allowedDomains(o.env);
  const sandbox: KernelOptions['sandbox'] = {
    enabled: true,
    failIfUnavailable: true, // a sandbox that cannot start stops the ticket instead of running unprotected
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    filesystem: fence ? { allowWrite: [dir], denyRead: credentialPaths(home) } : { allowWrite: [dir], denyRead: [...new Set([home, kernelRoot()])], allowRead: [dir, ...toolDirs(home)] },
    network: { allowedDomains: domains, strictAllowlist: domains[0] !== '*' },
  };
  return {
    sandbox,
    disallowedTools: secrets.flatMap((p) => ['Read', 'Edit', 'Write'].flatMap((t) => [`${t}(${p})`, `${t}(${p}/**)`])),
    hooks: { PreToolUse: [{ hooks: [fileToolHook(dir, { home, fence })] }] },
  };
}

/**
 * The orchestrator's own environment is readable by a worker's shell on Linux (`/proc/<pid>/environ`, same user),
 * and with `ps eww` on macOS unless the OS sandbox blocks it. So when any project runs in the kernel the
 * orchestrator restarts itself once with the same allow-list a worker gets. The catch: unsandboxed workers of
 * that orchestrator lose variables the list does not name; `SALU_ENV_PASS=NAME` brings one back, and
 * `SALU_ORCH_ENV=keep` turns the whole thing off.
 */
/** (Every project is confined now, so any project at all means workers get the allow-listed environment.) */
export function orchestratorEnvToScrub(anySandboxed: boolean, env: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> | null {
  if (!anySandboxed || !sandboxOn(env) || env.SALU_ORCH_SCRUBBED === '1' || (env.SALU_ORCH_ENV ?? '').toLowerCase() === 'keep') return null;
  const out = scrubSecrets(env, (env.SALU_ENV_PASS ?? '').split(',').map((x) => x.trim()).filter(Boolean));
  delete out.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB; // that one is for workers' children, not for us
  out.SALU_ORCH_SCRUBBED = '1';
  return out;
}

/**
 * After a sandboxed run: what in the kernel folder could point outside it? The file-tool guard checks a path
 * before the tool uses it, so a shell loop flipping a link between the check and the write can slip past; this
 * looks at what such tricks leave behind. Returns one line per finding (symlinks that leave the kernel, files
 * with several hard links). Findings are a warning for you, not a proof of escape.
 */
export function auditKernel(dir: string, o: { home?: string; limit?: number } = {}): string[] {
  const home = o.home ?? homedir();
  const kernel = canon(dir, dir, home);
  const found: string[] = [];
  const limit = o.limit ?? 20000;
  let seen = 0;
  const walk = (d: string) => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const n of names) {
      if (++seen > limit || found.length >= 50) return;
      const full = join(d, n);
      let st;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      const rel = full.slice(dir.length + 1);
      if (st.isSymbolicLink()) {
        const real = canon(full, kernel, home);
        if (!within(real, kernel)) found.push(`${rel} is a link to ${real}, outside the kernel`);
      } else if (st.isDirectory()) {
        if (n === 'node_modules' || (n === 'objects' && basename(d) === '.git')) continue;
        walk(full);
      } else if (st.isFile() && st.nlink > 1 && !rel.startsWith('.git/objects')) {
        found.push(`${rel} has ${st.nlink} hard links`);
      }
    }
  };
  walk(dir);
  return found;
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
