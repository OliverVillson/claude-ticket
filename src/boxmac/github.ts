import { CliError } from '../core/errors.ts';
import type { Exec } from './exec.ts';

/** Small wrappers around the `gh` CLI. Every failure becomes a sentence a person can act on. */
export interface RepoInfo {
  owner: string;
  name: string;
  isPrivate: boolean;
  sshUrl: string;
  httpsUrl: string;
}

const parseRepo = (out: string): RepoInfo => {
  const j = JSON.parse(out);
  return { owner: j.owner.login, name: j.name, isPrivate: !!j.isPrivate, sshUrl: j.sshUrl, httpsUrl: j.url.endsWith('.git') ? j.url : `${j.url}.git` };
};
const FIELDS = 'owner,name,isPrivate,sshUrl,url';

export async function ghReady(x: Exec): Promise<string> {
  const v = await x.capture(['gh', '--version']);
  if (!v.ok) throw new CliError('salu needs the GitHub CLI (gh) to make the repos. Install it from https://cli.github.com and run: gh auth login');
  const u = await x.capture(['gh', 'api', 'user', '-q', '.login']);
  if (!u.ok || !u.out.trim()) throw new CliError('gh is not logged in. Run: gh auth login   (then try again)');
  return u.out.trim();
}

export async function viewRepo(x: Exec, repo: string): Promise<RepoInfo | null> {
  const r = await x.capture(['gh', 'repo', 'view', repo, '--json', FIELDS]);
  if (r.ok) return parseRepo(r.out);
  if (/could not resolve|not found|404/i.test(r.err)) return null;
  throw new CliError(`could not look at ${repo} on GitHub: ${r.err.trim().split('\n').pop() || 'gh failed'}`);
}

/** Create a private repo with a README (so it has a branch to clone). Never makes a public one. */
export async function createPrivateRepo(x: Exec, repo: string): Promise<RepoInfo> {
  const r = await x.capture(['gh', 'repo', 'create', repo, '--private', '--add-readme']);
  if (!r.ok) throw new CliError(`could not create ${repo} on GitHub: ${r.err.trim().split('\n').pop() || 'gh failed'}`);
  const info = await viewRepo(x, repo);
  if (!info) throw new CliError(`GitHub made ${repo} but it cannot be seen yet. Try the same command again.`);
  return info;
}

/** Add a write deploy key unless that exact key is already on the repo. */
export async function ensureDeployKey(x: Exec, repo: string, pub: string, title: string): Promise<void> {
  const body = pub.trim().split(/\s+/).slice(0, 2).join(' ');
  const list = await x.capture(['gh', 'api', `repos/${repo}/keys`, '--paginate']);
  if (list.ok) {
    try {
      const keys = JSON.parse(list.out.replace(/\]\s*\[/g, ',')) as { key: string; read_only: boolean }[];
      if (keys.some((k) => k.key.trim() === body && !k.read_only)) return;
    } catch {
      /* fall through and just try to add it */
    }
  }
  const r = await x.capture(['gh', 'api', '-X', 'POST', `repos/${repo}/keys`, '-f', `title=${title}`, '-f', `key=${body}`, '-F', 'read_only=false']);
  if (!r.ok && !/already in use|key is already/i.test(r.err + r.out)) {
    throw new CliError(`could not add the deploy key to ${repo}: ${(r.err || r.out).trim().split('\n').pop()}. You need admin rights on that repo.`);
  }
}
