/**
 * Moving `.salu/memory` and `.salu/files` between the three places they live:
 *
 *   kernel copy (what workers write)  <->  the real project folder  <->  the project's git remote
 *
 * `reconcile` is the local half: a three-way merge per file against what both sides looked like at the
 * last sync (hashes in ~/.salu/memory-sync/<project>.json). One side changed: it wins. Both changed
 * differently: the project folder's version stays and the kernel's is kept next to it as `<file>.conflict-<hash>`.
 * `gitSync` is the git half and only runs from `salu sync`. A worker refresh (`refreshKernel`) is the
 * one-way, conflict-free variant used when a worker starts: it only brings your edits into the kernel.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ticketHome } from '../core/paths.ts';
import { folderSlug } from '../core/resolve.ts';
import { FILE_MAX_BYTES, MAX_ENTRIES, SALU_DIR, safeUnder, walkFiles } from './store.ts';

const AREAS = ['memory', 'files'] as const;

export interface Reconciled {
  toProject: string[];
  toKernel: string[];
  conflicts: string[];
  removed: string[];
  /** files a link or special file got in the way of; left as they were */
  skipped: string[];
}

type Manifest = Record<string, string>;

const manifestPath = (project: string) => join(ticketHome(), 'memory-sync', `${folderSlug(project)}.json`);

function loadManifest(project: string): Manifest {
  try {
    const m = JSON.parse(readFileSync(manifestPath(project), 'utf8'));
    return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
  } catch {
    return {};
  }
}
function saveManifest(project: string, m: Manifest): void {
  const p = manifestPath(project);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(m, null, 1));
}

const hashOf = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Every syncable file under a root's `.salu/` as `memory/x.md` -> sha256. Links, odd files and huge files are left out. */
function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const base = join(root, SALU_DIR);
  try {
    if (lstatSync(base).isSymbolicLink()) return out;
  } catch {
    return out;
  }
  for (const area of AREAS) {
    const dir = join(base, area);
    try {
      if (lstatSync(dir).isSymbolicLink()) continue;
    } catch {
      continue;
    }
    for (const rel of walkFiles(dir, MAX_ENTRIES)) {
      if (rel.includes('.tmp-')) continue;
      if (area === 'memory' && (rel.includes('/') || !rel.endsWith('.md'))) continue;
      const full = join(dir, rel);
      const s = lstatSync(full);
      if (s.size > FILE_MAX_BYTES) continue;
      out.set(`${area}/${rel}`, hashOf(readFileSync(full)));
    }
  }
  return out;
}

const abs = (root: string, key: string) => join(root, SALU_DIR, key);

function copyInto(from: string, to: string, key: string, as = key): void {
  const [area, ...rest] = as.split('/');
  const destBase = join(to, SALU_DIR, area!);
  mkdirSync(destBase, { recursive: true });
  const dest = safeUnder(destBase, rest.join('/')); // never write through a link
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${process.pid}`;
  const src = abs(from, key);
  if (!lstatSync(src).isFile()) return; // swapped for a link since the snapshot: skip
  writeFileSync(tmp, readFileSync(src));
  renameSync(tmp, dest);
}

function removeFrom(root: string, key: string): void {
  const [area, ...rest] = key.split('/');
  try {
    rmSync(safeUnder(join(root, SALU_DIR, area!), rest.join('/')));
  } catch {
    /* already gone, or a link: leave it */
  }
}

const conflictName = (key: string, hash: string) => (key.endsWith('.md') ? `${key.slice(0, -3)}.conflict-${hash.slice(0, 6)}.md` : `${key}.conflict-${hash.slice(0, 6)}`);

/**
 * Three-way merge of `.salu/memory` and `.salu/files` between the kernel copy and the real project folder.
 * `oneWay: 'down'` only brings project changes into files the kernel has not touched (worker start).
 */
export function reconcile(project: string, projectRoot: string, kernelRoot: string, o: { oneWay?: 'down'; dryRun?: boolean } = {}): Reconciled {
  const res: Reconciled = { toProject: [], toKernel: [], conflicts: [], removed: [], skipped: [] };
  if (projectRoot === kernelRoot) return res;
  const base = loadManifest(project);
  const p = snapshot(projectRoot);
  const k = snapshot(kernelRoot);
  const next: Manifest = { ...base };
  const keys = new Set([...p.keys(), ...k.keys(), ...Object.keys(base)]);
  const down = o.oneWay === 'down';
  const act = (fn: () => void) => {
    if (!o.dryRun) fn();
  };
  for (const key of [...keys].sort()) {
    try {
      step(key);
    } catch {
      res.skipped.push(key);
      if (base[key] === undefined) delete next[key];
      else next[key] = base[key]!;
    }
  }
  function step(key: string): void {
    const b = base[key];
    const ph = p.get(key);
    const kh = k.get(key);
    if (ph === kh) {
      if (ph === undefined) delete next[key];
      else next[key] = ph;
      return;
    }
    const pChanged = ph !== b;
    const kChanged = kh !== b;
    if (!kChanged) {
      // only the project side moved: the kernel follows
      if (ph === undefined) {
        act(() => removeFrom(kernelRoot, key));
        res.removed.push(key);
        delete next[key];
      } else {
        act(() => copyInto(projectRoot, kernelRoot, key));
        res.toKernel.push(key);
        next[key] = ph;
      }
    } else if (!pChanged) {
      if (down) return; // worker start: the kernel's own changes wait for `salu sync`
      if (kh === undefined) {
        act(() => removeFrom(projectRoot, key));
        res.removed.push(key);
        delete next[key];
      } else {
        act(() => copyInto(kernelRoot, projectRoot, key));
        res.toProject.push(key);
        next[key] = kh;
      }
    } else {
      // both changed, differently
      if (down) return;
      if (kh === undefined) {
        // kernel deleted it, project edited it: keep the edit
        act(() => copyInto(projectRoot, kernelRoot, key));
        res.toKernel.push(key);
        next[key] = ph!;
      } else if (ph === undefined) {
        // project deleted it, kernel edited it: keep the edit
        act(() => copyInto(kernelRoot, projectRoot, key));
        res.toProject.push(key);
        next[key] = kh;
      } else {
        const copy = conflictName(key, kh);
        act(() => {
          copyInto(kernelRoot, projectRoot, key, copy);
          copyInto(kernelRoot, kernelRoot, key, copy);
          copyInto(projectRoot, kernelRoot, key); // the kernel takes the project's version
        });
        res.conflicts.push(key);
        next[key] = ph;
        next[copy] = kh;
      }
    }
  }
  if (!o.dryRun) saveManifest(project, next);
  return res;
}

/** Called when a worker starts: your edits to memory and files reach the kernel copy, nothing else moves. */
export function refreshKernel(project: string, projectRoot: string, kernelRoot: string): Reconciled {
  try {
    keepOutOfBranches(kernelRoot);
    return reconcile(project, projectRoot, kernelRoot, { oneWay: 'down' });
  } catch {
    return { toProject: [], toKernel: [], conflicts: [], removed: [], skipped: [] }; // a worker must still start
  }
}

/** In the kernel's git repo, `git add -A` by an agent must not sweep `.salu/` into a ticket branch. */
function keepOutOfBranches(kernelRoot: string): void {
  const exclude = join(kernelRoot, '.git', 'info', 'exclude');
  if (!existsSync(join(kernelRoot, '.git'))) return;
  mkdirSync(dirname(exclude), { recursive: true });
  const cur = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  if (!cur.split('\n').includes('/.salu/')) writeFileSync(exclude, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}/.salu/\n`);
}

// ---- git ---------------------------------------------------------------------------------------------

export interface GitSyncResult {
  committed: boolean;
  pulled: boolean;
  pushed: boolean;
  notes: string[];
}

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return { ok: r.exitCode === 0, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
};

/**
 * Commit `.salu/` in the project repo (only those paths; your other staged work is left alone), bring in
 * what the remote has (fast-forward only), and push the current branch when it tracks a remote branch.
 * Never touches `salu/inbox`, other branches, or anything outside `.salu/`.
 */
export function gitSync(projectRoot: string, o: { push?: boolean; pull?: boolean; afterPull?: () => boolean } = {}): GitSyncResult {
  const res: GitSyncResult = { committed: false, pulled: false, pushed: false, notes: [] };
  if (!existsSync(join(projectRoot, '.git'))) {
    res.notes.push('not a git repository: memory and files stay on this computer');
    return res;
  }
  const commit = () => {
    if (!existsSync(join(projectRoot, SALU_DIR))) return false;
    git(projectRoot, 'add', '-A', '--', SALU_DIR);
    if (git(projectRoot, 'diff', '--cached', '--quiet', '--', SALU_DIR).ok) return false;
    const c = git(projectRoot, 'commit', '-q', '-m', 'salu: sync memory and files', '--', SALU_DIR);
    if (!c.ok) res.notes.push(`could not commit .salu: ${c.err.split('\n').pop()}`);
    return c.ok;
  };
  res.committed = commit();
  const hasRemote = git(projectRoot, 'remote', 'get-url', 'origin').ok;
  const upstream = git(projectRoot, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}');
  if (!hasRemote) {
    res.notes.push('no git remote: committed locally only');
    return res;
  }
  if (o.pull !== false && upstream.ok) {
    const f = git(projectRoot, 'pull', '--ff-only', '-q');
    if (f.ok) {
      res.pulled = true;
      if (o.afterPull?.()) res.committed = commit() || res.committed;
    } else res.notes.push(`could not fast-forward from the remote (${f.err.split('\n').pop() || 'diverged'}): pull it yourself, then run salu sync again`);
  } else if (!upstream.ok) res.notes.push('this branch does not track a remote branch: nothing pulled or pushed');
  if (o.push !== false && upstream.ok && !res.notes.some((n) => n.startsWith('could not'))) {
    const ahead = git(projectRoot, 'rev-list', '--count', '@{u}..HEAD');
    if (ahead.ok && Number(ahead.out) > 0) {
      const pr = git(projectRoot, 'push', '-q');
      if (pr.ok) res.pushed = true;
      else res.notes.push(`push failed: ${pr.err.split('\n').pop()}`);
    }
  }
  return res;
}
