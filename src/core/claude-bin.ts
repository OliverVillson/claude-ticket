// Finding the user's Claude Code. The compiled salu binary carries the Agent SDK but not the SDK's
// platform-specific `claude` executable, so it has to launch the one installed on the machine.
import { accessSync, constants, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, join } from 'node:path';

export interface ClaudeBin {
  path: string;
  /** Where it was found: `SALU_CLAUDE_PATH`, `PATH`, or the install location's folder. */
  source: string;
}

export const INSTALL_HINT =
  'Install Claude Code (curl -fsSL https://claude.ai/install.sh | bash), run `claude` once to log in, then try again. ' +
  'Already installed somewhere unusual? Set SALU_CLAUDE_PATH=/path/to/claude.';

export const CLAUDE_MISSING = `salu could not find Claude Code on this machine. ${INSTALL_HINT}`;

/** Marks errors that are about the machine (missing or logged-out Claude Code), not about the ticket. */
export class EnvironmentError extends Error {
  readonly code = 'SALU_ENV';
}

export interface FindOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Test hook: is this an executable file? */
  isExecutable?: (path: string) => boolean;
  /** Test hook: list a directory. */
  listDir?: (path: string) => string[];
}

function defaultIsExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultListDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

/** The usual places Claude Code ends up, after PATH: native installer, Homebrew, npm, bun, volta, nvm. */
export function installLocations(home: string, listDir: (p: string) => string[] = defaultListDir): string[] {
  const nvm = join(home, '.nvm', 'versions', 'node');
  return [
    join(home, '.claude', 'local', 'claude'),
    join(home, '.local', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    join(home, '.npm-global', 'bin', 'claude'),
    join(home, '.bun', 'bin', 'claude'),
    join(home, '.volta', 'bin', 'claude'),
    join(home, '.claude', 'bin', 'claude'),
    ...listDir(nvm).sort().reverse().map((v) => join(nvm, v, 'bin', 'claude')),
  ];
}

/**
 * SALU_CLAUDE_PATH if it is set and valid, else `claude` on PATH, else the usual install
 * locations. Null when none is found. An invalid SALU_CLAUDE_PATH is not silently skipped:
 * the caller should say so (see `checkClaude`).
 */
export function findClaude(o: FindOptions = {}): ClaudeBin | null {
  const env = o.env ?? process.env;
  const isExec = o.isExecutable ?? defaultIsExecutable;
  const home = o.home ?? env.HOME ?? homedir();
  const explicit = env.SALU_CLAUDE_PATH;
  if (explicit) return isExec(explicit) ? { path: explicit, source: 'SALU_CLAUDE_PATH' } : null;
  for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const p = join(dir, 'claude');
    if (isExec(p)) return { path: p, source: 'PATH' };
  }
  for (const p of installLocations(home, o.listDir)) if (isExec(p)) return { path: p, source: 'install location' };
  return null;
}

export interface ClaudeCheck {
  ok: boolean;
  path?: string;
  source?: string;
  /** What to tell the user when not ok. */
  problem?: string;
}

/** Is Claude Code reachable? Says why not in words a person can act on. */
export function checkClaude(o: FindOptions = {}): ClaudeCheck {
  const env = o.env ?? process.env;
  const found = findClaude(o);
  if (found) return { ok: true, ...found };
  if (env.SALU_CLAUDE_PATH) return { ok: false, problem: `SALU_CLAUDE_PATH points to ${env.SALU_CLAUDE_PATH}, which is not an executable file. ${INSTALL_HINT}` };
  return { ok: false, problem: CLAUDE_MISSING };
}

/** True when this process is a compiled salu binary (not `bun src/index.ts`). */
export function runningCompiled(execPath = process.execPath): boolean {
  return !/^bun(-\w+)?(\.exe)?$/i.test(basename(execPath));
}

/**
 * The `pathToClaudeCodeExecutable` option for the Agent SDK. An explicit SALU_CLAUDE_PATH always
 * wins; the compiled binary falls back to the installed Claude Code; from source the SDK's own
 * bundled executable is used unless it is missing (then the installed one is tried).
 */
export function claudeExecutableOption(o: FindOptions & { compiled?: boolean } = {}): string | undefined {
  const env = o.env ?? process.env;
  if (env.SALU_CLAUDE_PATH) return env.SALU_CLAUDE_PATH;
  if (o.compiled ?? runningCompiled()) return findClaude(o)?.path;
  return undefined;
}

export const LOGIN_PROBLEM = 'Claude Code login expired or missing: run `claude`, then /login, then `salu run`.';

/** Text Claude Code gives when it cannot authenticate or be billed: the machine's problem, not the ticket's. */
const AUTH_FAILURE = new RegExp(
  [
    'not logged in', 'please run /login', 'run /login', 'failed to authenticate', 'could not be refreshed',
    'oauth (session|token).{0,30}(expired|invalid|revoked)', 'invalid api key', 'invalid x-api-key',
    'authentication[_ ]error', 'authentication[_ ]failed', 'invalid[_ ]authentication', '\\b401\\b.{0,40}(unauthorized|authenticat)',
    'credit balance is too low',
  ].join('|'),
  'i',
);

/**
 * Turn the SDK's or the shell's "can't start claude" errors into an EnvironmentError message;
 * null for anything that is the ticket's own problem.
 */
export function environmentProblem(text: string | null | undefined): string | null {
  const s = String(text ?? '');
  if (!s) return null;
  if (/native cli binary for .* not found|pathToClaudeCodeExecutable|claude code (native )?(binary|executable) not found|spawn .*claude.* ENOENT|ENOENT.*claude|salu could not find claude code/i.test(s)) return CLAUDE_MISSING;
  if (AUTH_FAILURE.test(s)) return LOGIN_PROBLEM;
  return null;
}

/**
 * The reason `salu run` cannot work on this machine, or null when it can. Only enforced where salu
 * has no executable of its own: the compiled binary, or when SALU_CLAUDE_PATH was set (and is wrong).
 */
export function preflightClaude(o: FindOptions & { compiled?: boolean } = {}): string | null {
  const env = o.env ?? process.env;
  if (env.SALU_WORKER === 'fake') return null;
  if (!(o.compiled ?? runningCompiled()) && !env.SALU_CLAUDE_PATH) return null;
  const c = checkClaude(o);
  return c.ok ? null : c.problem ?? CLAUDE_MISSING;
}

/**
 * Cheap login check: `claude auth status` costs no model turn. Returns the problem only when it
 * clearly says logged out; an unclear answer is not a problem (the first ticket will tell).
 */
export async function loginProblem(claudePath: string, run?: (cmd: string[]) => Promise<{ ok: boolean; out: string }>): Promise<string | null> {
  const exec = run ?? (async (cmd: string[]) => {
    try {
      const p = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe', env: process.env });
      const timer = setTimeout(() => p.kill(), 8000);
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      clearTimeout(timer);
      return { ok: (await p.exited) === 0, out: `${out}\n${err}` };
    } catch {
      return { ok: true, out: '' };
    }
  });
  const r = await exec([claudePath, 'auth', 'status']);
  if (/"loggedIn"\s*:\s*false/i.test(r.out) || AUTH_FAILURE.test(r.out) || (!r.ok && /logged out|not authenticated/i.test(r.out))) return LOGIN_PROBLEM;
  return null;
}
