import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { CliError } from './errors.ts';

/** `https://github.com/a/salu.git`, `git@github.com:a/salu`, `/srv/repos/salu/` → `salu`. */
export function repoNameFromUrl(url: string): string {
  const last = url.trim().replace(/[/\\]+$/, '').split(/[/:\\]/).pop() ?? '';
  return last.replace(/\.git$/i, '') || 'repo';
}

/** Friendlier words for the ways `git clone` fails, else git's own last line. */
export function cloneProblem(stderr: string, url: string): string {
  const s = stderr.trim();
  const last = s.split('\n').filter(Boolean).pop() ?? 'git clone failed';
  if (/authentication failed|could not read (username|password)|terminal prompts disabled|permission denied \(publickey\)|invalid username or password|403/i.test(s)) {
    return `git could not sign in to ${url}. Check the URL first (GitHub asks for a login for a repo that does not exist, too). For a private repo, log in (gh auth login, or set up an SSH key or a credential helper) and try again.`;
  }
  if (/repository not found|not found|does not appear to be a git repository|could not resolve host|unable to access|no such file or directory/i.test(s)) {
    return `could not clone ${url}: ${last}. Check the URL (and your network); a private repo also needs you to be logged in.`;
  }
  return `git clone failed: ${last}`;
}

/**
 * Clone `url` into `dir` (created if missing; an existing folder must be empty). Done by salu itself,
 * so a worker's permissions never come into it. On failure a folder we created is removed again.
 */
export function cloneRepo(url: string, dir: string, o: { env?: NodeJS.ProcessEnv; log?: (line: string) => void } = {}): void {
  const env = { ...(o.env ?? process.env) };
  if (!url.trim() || url.startsWith('-')) throw new CliError(`"${url}" is not a git URL (like https://github.com/you/repo or git@github.com:you/repo.git)`);
  const git = Bun.which('git', { PATH: env.PATH ?? '' });
  if (!git) throw new CliError('git is not installed (or not on your PATH), so salu cannot clone. Install git, or clone yourself and use: salu add project "name" <folder>');
  const existed = existsSync(dir);
  if (existed) {
    if (!statSync(dir).isDirectory()) throw new CliError(`${dir} is a file, not a folder`);
    if (readdirSync(dir).length) throw new CliError(`${dir} already has files in it, so salu will not clone there. Pick an empty or new folder (--path), or register the existing folder: salu add project "name" ${dir}`);
  }
  o.log?.(`cloning ${url} → ${dir} …`);
  if (!existed) mkdirSync(dir, { recursive: true });
  // Never wait for a password prompt that nobody can see.
  env.GIT_TERMINAL_PROMPT = '0';
  const r = Bun.spawnSync([git, 'clone', '--', url, dir], { env: env as Record<string, string>, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) {
    if (!existed) rmSync(dir, { recursive: true, force: true });
    throw new CliError(cloneProblem(r.stderr.toString(), url));
  }
}

export { basename };
