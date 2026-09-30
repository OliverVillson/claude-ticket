import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CliError } from '../core/errors.ts';
import { folderSlug } from '../core/resolve.ts';
import { ticketHome } from '../core/paths.ts';
import { INBOX_BRANCH } from './format.ts';

/** Working copy of the inbox branch for one project: ~/.salu/sync/<project>. */
export function inboxDir(projectName: string): string {
  return join(process.env.SALU_SYNC_DIR || join(ticketHome(), 'sync'), folderSlug(projectName));
}

const GIT_ENV = (): Record<string, string> => ({
  ...(process.env as Record<string, string>),
  GIT_TERMINAL_PROMPT: '0', // never wait for a password prompt nobody can see
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes',
  GIT_AUTHOR_NAME: 'salu',
  GIT_AUTHOR_EMAIL: 'salu@localhost',
  GIT_COMMITTER_NAME: 'salu',
  GIT_COMMITTER_EMAIL: 'salu@localhost',
});

export interface GitResult {
  ok: boolean;
  out: string;
  err: string;
}

export function git(cwd: string, args: string[]): GitResult {
  const r = Bun.spawnSync(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd, stdout: 'pipe', stderr: 'pipe', env: GIT_ENV() });
  return { ok: r.exitCode === 0, out: r.stdout.toString(), err: r.stderr.toString() };
}

/** Git's own last line, with the words people need for the common failures. */
export function gitProblem(err: string, url: string): string {
  const s = err.trim();
  const last = s.split('\n').filter(Boolean).pop() ?? 'git failed';
  if (/authentication failed|could not read (username|password)|terminal prompts disabled|permission denied|invalid username or password|403/i.test(s)) {
    return `git could not sign in to ${url}. Log in on this computer (gh auth login, an SSH key or a credential helper) and try again.`;
  }
  if (/repository not found|does not appear to be a git repository|could not resolve host|unable to access|no such file or directory|not found/i.test(s)) {
    return `could not reach ${url}: ${last}`;
  }
  return last;
}

/** Check that `url` is a reachable git remote (used by `salu remote add`). */
export function checkRemote(url: string): string | null {
  if (!url.trim() || url.startsWith('-')) return `"${url}" is not a git URL (like https://github.com/you/repo or git@github.com:you/repo.git)`;
  const r = git(process.cwd(), ['ls-remote', '--heads', url]);
  return r.ok ? null : gitProblem(r.err, url);
}

function ensureRepo(dir: string, url: string): void {
  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(dir, { recursive: true });
    const i = git(dir, ['init', '-q']);
    if (!i.ok) throw new CliError(`git init failed in ${dir}: ${i.err.trim()}`);
  }
  const cur = git(dir, ['remote', 'get-url', 'origin']);
  if (!cur.ok) git(dir, ['remote', 'add', 'origin', url]);
  else if (cur.out.trim() !== url) git(dir, ['remote', 'set-url', 'origin', url]);
}

/**
 * Bring the working copy to the remote's inbox branch (creating an orphan branch when the remote has
 * none), write `files` into it (existing names are left alone), commit and push. A rejected push means
 * the other side pushed first: fetch and try again. Files never change once written, so that is safe.
 * Returns the names actually added.
 */
export function exchange(dir: string, url: string, files: Record<string, string>): { added: string[] } {
  ensureRepo(dir, url);
  let last = '';
  for (let attempt = 0; attempt < 6; attempt++) {
    const f = git(dir, ['fetch', '-q', 'origin', `+refs/heads/${INBOX_BRANCH}:refs/remotes/origin/${INBOX_BRANCH}`]);
    const remoteHas = f.ok;
    if (!f.ok && !/couldn't find remote ref/i.test(f.err)) throw new CliError(gitProblem(f.err, url));
    if (remoteHas) {
      const c = git(dir, ['checkout', '-q', '-f', '-B', INBOX_BRANCH, `origin/${INBOX_BRANCH}`]);
      if (!c.ok) throw new CliError(`git checkout failed: ${c.err.trim()}`);
    } else {
      // The remote has no inbox yet: start an empty branch (dropping a stale local one).
      git(dir, ['update-ref', '-d', `refs/heads/${INBOX_BRANCH}`]);
      git(dir, ['symbolic-ref', 'HEAD', `refs/heads/${INBOX_BRANCH}`]);
      git(dir, ['rm', '-rq', '--cached', '--ignore-unmatch', '.']);
      git(dir, ['clean', '-fdxq']);
    }
    const added: string[] = [];
    const all: Record<string, string> = remoteHas ? { ...files } : { 'salu-inbox/README.md': README, ...files };
    for (const [name, text] of Object.entries(all)) {
      const p = join(dir, name);
      if (existsSync(p)) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, text);
      added.push(name);
    }
    if (!added.length) return { added };
    git(dir, ['add', '-A', 'salu-inbox']);
    const c = git(dir, ['commit', '-q', '-m', `salu: ${added.length} file${added.length === 1 ? '' : 's'}`]);
    if (!c.ok) throw new CliError(`git commit failed: ${c.err.trim() || c.out.trim()}`);
    const p = git(dir, ['push', '-q', 'origin', `HEAD:refs/heads/${INBOX_BRANCH}`]);
    if (p.ok) return { added };
    last = p.err;
    if (!/rejected|non-fast-forward|fetch first|cannot lock ref|failed to update ref/i.test(p.err)) throw new CliError(gitProblem(p.err, url));
  }
  throw new CliError(`could not push to ${url} after several tries: ${gitProblem(last, url)}`);
}

/** Files in a directory of the working copy (name → text), for the ones `want` accepts. */
export function readDir(dir: string, sub: string, want: (name: string) => boolean): Array<{ name: string; text: string }> {
  const d = join(dir, sub);
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter((n) => n.endsWith('.json') && want(n))
    .sort()
    .map((name) => ({ name, text: readFileSync(join(d, name), 'utf8') }));
}

const README = `# salu inbox

This branch is how salu on your computer and salu on the box talk to each other through git.
It is managed by salu: files are only ever added, never edited, so two machines never conflict.

- tickets/<id>.json   tickets sent to the box
- messages/<id>.json  what the orchestrator on the box tells you (salu notif)

Do not merge this branch into your code.
`;
