import { existsSync, linkSync, lstatSync, unlinkSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { CliError } from '../core/errors.ts';
import { folderSlug } from '../core/resolve.ts';
import { ticketHome } from '../core/paths.ts';
import { INBOX_BRANCH, MAX_FILE_BYTES, MESSAGES_DIR, REPLIES_DIR, TICKETS_DIR } from './format.ts';

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
  const r = Bun.spawnSync(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'core.symlinks=false', ...args], { cwd, stdout: 'pipe', stderr: 'pipe', env: GIT_ENV() });
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
      if (existsSync(p) || lstatOrNull(p)) continue;
      assertInside(dir, dirname(p));
      // Write to a temp name in the verified folder, then rename: never onto an existing file or link.
      const tmp = join(dirname(p), `.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
      writeFileSync(tmp, text, { flag: 'wx' });
      try {
        linkSync(tmp, p); // fails if p exists (even as a dangling link), unlike rename
      } catch (e: any) {
        if (e?.code !== 'EPERM' && e?.code !== 'ENOTSUP' && e?.code !== 'EXDEV') throw e;
        writeFileSync(p, text, { flag: 'wx' }); // a file system without hard links
      } finally {
        unlinkSync(tmp);
      }
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

function lstatOrNull(p: string) {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

/**
 * The remote controls the tree we check out, so a path inside it may be a symlink (git is run with
 * core.symlinks=false, which turns them into plain files, and this checks again): create the folder
 * step by step and refuse anything that is not a real directory inside `dir`.
 */
function assertInside(dir: string, target: string): void {
  const root = realpathSync(dir);
  const rel = target.slice(dir.length).split(sep).filter(Boolean);
  let cur = dir;
  for (const part of rel) {
    cur = join(cur, part);
    const st = lstatOrNull(cur);
    if (!st) mkdirSync(cur);
    else if (!st.isDirectory() || st.isSymbolicLink()) throw new CliError(`the inbox on the remote is not safe (${part} is not a plain folder); refusing to write into it`);
  }
  const real = realpathSync(target);
  if (real !== root && !real.startsWith(root + sep)) throw new CliError('the inbox on the remote points outside the sync folder; refusing to write into it');
}

const MAX_FILES = 10000;

/**
 * Rewrite existing inbox files in one commit (used to re-sign them after the key changes). `fn` gets each
 * file's text and returns the new text, or null to leave it alone. Same safety checks as `exchange`; a
 * rejected push is fetched and the rewrite redone from the remote's tree. Returns how many files changed.
 */
export function rewriteInbox(dir: string, url: string, fn: (text: string) => string | null): number {
  ensureRepo(dir, url);
  let last = '';
  for (let attempt = 0; attempt < 6; attempt++) {
    const f = git(dir, ['fetch', '-q', 'origin', `+refs/heads/${INBOX_BRANCH}:refs/remotes/origin/${INBOX_BRANCH}`]);
    if (!f.ok) {
      if (/couldn't find remote ref/i.test(f.err)) return 0; // nothing to re-sign yet
      throw new CliError(gitProblem(f.err, url));
    }
    const c = git(dir, ['checkout', '-q', '-f', '-B', INBOX_BRANCH, `origin/${INBOX_BRANCH}`]);
    if (!c.ok) throw new CliError(`git checkout failed: ${c.err.trim()}`);
    let changed = 0;
    for (const sub of [TICKETS_DIR, REPLIES_DIR, MESSAGES_DIR]) {
      for (const { name, text } of readDir(dir, sub, () => true)) {
        const next = fn(text);
        if (next === null || next === text) continue;
        writeFileSync(join(dir, sub, name), next); // readDir verified the folder and that the file is a plain file
        changed++;
      }
    }
    if (!changed) return 0;
    git(dir, ['add', '-A', 'salu-inbox']);
    const cm = git(dir, ['commit', '-q', '-m', `salu: re-signed ${changed} file${changed === 1 ? '' : 's'}`]);
    if (!cm.ok) throw new CliError(`git commit failed: ${cm.err.trim() || cm.out.trim()}`);
    const p = git(dir, ['push', '-q', 'origin', `HEAD:refs/heads/${INBOX_BRANCH}`]);
    if (p.ok) return changed;
    last = p.err;
    if (!/rejected|non-fast-forward|fetch first|cannot lock ref|failed to update ref/i.test(p.err)) throw new CliError(gitProblem(p.err, url));
  }
  throw new CliError(`could not push to ${url} after several tries: ${gitProblem(last, url)}`);
}

/** Files in a directory of the working copy (name → text), for the ones `want` accepts. */
export function readDir(dir: string, sub: string, want: (name: string) => boolean): Array<{ name: string; text: string }> {
  const d = join(dir, sub);
  const top = lstatOrNull(d);
  if (!top || !top.isDirectory() || top.isSymbolicLink()) return [];
  try {
    assertInside(dir, d);
  } catch {
    return [];
  }
  const out: Array<{ name: string; text: string }> = [];
  for (const name of readdirSync(d).filter((n) => n.endsWith('.json') && want(n)).sort().slice(-MAX_FILES)) {
    const st = lstatOrNull(join(d, name));
    if (!st || !st.isFile() || st.size > MAX_FILE_BYTES) continue; // never read a huge file or follow a link
    out.push({ name, text: readFileSync(join(d, name), 'utf8') });
  }
  return out;
}

const README = `# salu inbox

This branch is how salu on your computer and salu on the box talk to each other through git.
It is managed by salu: files are only ever added, never edited, so two machines never conflict.

- tickets/<id>.json   tickets sent to the box
- messages/<id>.json  what the orchestrator on the box tells you (salu notif)

Do not merge this branch into your code.
`;
