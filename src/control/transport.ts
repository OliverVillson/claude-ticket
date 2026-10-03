/**
 * Files in the control repo. Write-once and unique names, so two pushers never conflict: the loser
 * fetches and pushes again. `gitTransport` works on any git url, including a local bare repo (tests).
 * `memoryTransport` is a no-git fake for unit tests.
 */
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { MAX_FILE_BYTES } from '../sync/format.ts';
import { GITHUB_KNOWN_HOSTS } from './hosts.ts';

export interface ControlTransport {
  /** Write-once by default: an existing path is left alone and put returns. `overwrite` replaces it (heartbeat only). */
  put(path: string, body: string, o?: { overwrite?: boolean }): Promise<void>;
  list(dir: string): Promise<string[]>;
  get(path: string): Promise<string | undefined>;
}

const PATH_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
function checkPath(p: string): void {
  if (!PATH_RE.test(p) || p.split('/').some((s) => s === '.' || s === '..')) throw new Error(`bad control path "${p.slice(0, 80)}"`);
}
function checkBody(b: string): void {
  if (Buffer.byteLength(b) > MAX_FILE_BYTES) throw new Error('control file is bigger than 64 KiB');
}

export function memoryTransport(): ControlTransport & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    async put(path, body, o) {
      checkPath(path);
      checkBody(body);
      if (files.has(path) && !o?.overwrite) return;
      files.set(path, body);
    },
    async list(dir) {
      checkPath(dir);
      const out = new Set<string>();
      for (const k of files.keys()) if (k.startsWith(`${dir}/`) && !k.slice(dir.length + 1).includes('/')) out.add(k.slice(dir.length + 1));
      return [...out].sort();
    },
    async get(path) {
      checkPath(path);
      return files.get(path);
    },
  };
}

/**
 * With a deploy key, ssh trusts only github.com's pinned host key (or `hostKeys`, known_hosts lines, for tests): the box's
 * service runs as root, whose own known_hosts has never seen github.com, and BatchMode would then fail with
 * "Host key verification failed".
 */
export function gitEnv(sshKey?: string, hostKeys = GITHUB_KNOWN_HOSTS): Record<string, string> {
  const e: Record<string, string> = {
    ...(process.env as Record<string, string>),
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'salu',
    GIT_AUTHOR_EMAIL: 'salu@localhost',
    GIT_COMMITTER_NAME: 'salu',
    GIT_COMMITTER_EMAIL: 'salu@localhost',
  };
  if (sshKey) {
    const kh = `${sshKey}.known_hosts`;
    mkdirSync(dirname(kh), { recursive: true });
    writeFileSync(kh, hostKeys, { mode: 0o644 });
    e.GIT_SSH_COMMAND = `ssh -i ${JSON.stringify(sshKey)} -o IdentitiesOnly=yes -o BatchMode=yes -o UserKnownHostsFile=${JSON.stringify(kh)} -o StrictHostKeyChecking=yes`;
  } else e.GIT_SSH_COMMAND = process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes';
  return e;
}

export function problem(err: string): Error {
  const s = err.trim();
  if (/host key verification failed|remote host identification has changed/i.test(s)) return new Error("ssh does not trust the control repo's host key (github.com's pinned key did not match). Do not continue; check this box's network and run salu update.");
  if (/does not appear to be a git repository|repository not found|could not resolve host|no such file/i.test(s) && !/permission denied/i.test(s)) return new Error(`could not reach the control repo: ${s.split('\n').filter(Boolean)[0]}`);
  if (/permission denied|authentication failed|could not read|403/i.test(s)) return new Error('git could not sign in to the control repo. Check its deploy key and try again.');
  return new Error(`could not reach the control repo: ${s.split('\n').filter(Boolean).pop() ?? 'git failed'}`);
}

/** How big the local control checkout may get before we refuse to pull more; SALU_CONTROL_MAX_MB overrides (default 128). */
export function controlMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(1, Number(env.SALU_CONTROL_MAX_MB) || 128) * 1024 * 1024;
}
function dirBytes(d: string): number {
  const r = Bun.spawnSync(['du', '-sk', d], { stdout: 'pipe', stderr: 'pipe' });
  return r.exitCode === 0 ? Number(r.stdout.toString().split(/\s/)[0]) * 1024 : 0;
}

export function gitTransport(opts: { url: string; sshKey?: string; hostKeys?: string; dir: string; maxBytes?: number }): ControlTransport {
  const { url, dir } = opts;
  const root = resolve(dir);
  const maxBytes = opts.maxBytes ?? controlMaxBytes();
  const env = gitEnv(opts.sshKey, opts.hostKeys);
  const git = (args: string[]) => {
    const r = Bun.spawnSync(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'core.symlinks=false', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe', env });
    return { ok: r.exitCode === 0, out: r.stdout.toString(), err: r.stderr.toString() };
  };
  let branch = 'main';
  let remoteHas = false;
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(f: () => Promise<T> | T): Promise<T> => {
    const p = queue.then(f, f);
    queue = p.catch(() => {});
    return p;
  };

  function init(): void {
    if (!existsSync(join(root, '.git'))) {
      mkdirSync(root, { recursive: true });
      if (!git(['init', '-q']).ok) throw new Error(`git init failed in ${root}`);
    }
    const cur = git(['remote', 'get-url', 'origin']);
    if (!cur.ok) git(['remote', 'add', 'origin', url]);
    else if (cur.out.trim() !== url) git(['remote', 'set-url', 'origin', url]);
  }


  /** Bring the working copy to the remote's default branch (stays empty while the remote has none). */
  function refresh(): void {
    init();
    const head = git(['ls-remote', '--symref', 'origin', 'HEAD']);
    if (!head.ok) throw problem(head.err);
    const m = /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(head.out);
    remoteHas = !!head.out.trim();
    if (m) branch = m[1]!;
    if (!remoteHas) {
      git(['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
      return;
    }
    const f = git(['fetch', '-q', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
    if (!f.ok) throw problem(f.err);
    const c = git(['checkout', '-q', '-f', '-B', branch, `origin/${branch}`]);
    if (!c.ok) throw new Error(`git checkout failed: ${c.err.trim()}`);
    // A control repo holds only small JSON (every file is write-once and ≤64 KiB), so it stays tiny. If it has grown
    // past the cap, someone with write access may be filling it to exhaust the box's disk: stop pulling and say so,
    // rather than keep fetching ever-larger pushes into .git and the working tree. The per-file memory cap in
    // readLocal still holds; this bounds the total on disk.
    const size = dirBytes(root);
    if (size > maxBytes) throw new Error(`the control repo on this box has grown to ${(size / 1e6).toFixed(0)} MB, past the ${(maxBytes / 1e6).toFixed(0)} MB limit: refusing to pull more. Check who has write access to it; raise SALU_CONTROL_MAX_MB only if this much is expected.`);
  }

  const inside = (p: string): string => {
    const full = resolve(root, p);
    if (!full.startsWith(root + sep)) throw new Error('path escapes the control folder');
    return full;
  };
  const readLocal = (p: string): string | undefined => {
    const full = inside(p);
    try {
      const st = lstatSync(full);
      // Check the size before reading: a huge file in the repo must never be loaded into memory.
      if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_FILE_BYTES) return undefined;
      return readFileSync(full, 'utf8');
    } catch {
      return undefined;
    }
  };

  return {
    put: (path, body, o) =>
      serial(async () => {
        checkPath(path);
        checkBody(body);
        let last = '';
        for (let attempt = 0; attempt < 6; attempt++) {
          refresh();
          const full = inside(path);
          if (existsSync(full) && !o?.overwrite) return;
          mkdirSync(dirname(full), { recursive: true });
          if (o?.overwrite) writeFileSync(full, body);
          else {
            const tmp = `${full}.tmp-${process.pid}`;
            writeFileSync(tmp, body, { flag: 'w' });
            try {
              linkSync(tmp, full); // fails when something is already there
            } finally {
              unlinkSync(tmp);
            }
          }
          git(['add', '-A', '--', path]);
          const c = git(['commit', '-q', '-m', `salu control: ${path}`]);
          if (!c.ok) {
            if (/nothing to commit|nothing added/i.test(c.out + c.err)) return;
            throw new Error(`git commit failed: ${(c.err || c.out).trim()}`);
          }
          const p = git(['push', '-q', 'origin', `HEAD:refs/heads/${branch}`]);
          if (p.ok) return;
          last = p.err;
          if (!/rejected|non-fast-forward|fetch first|cannot lock ref|failed to update ref/i.test(p.err)) throw problem(p.err);
        }
        throw new Error(`could not push to the control repo after several tries: ${last.trim().split('\n').pop()}`);
      }),
    list: (dir) =>
      serial(async () => {
        checkPath(dir);
        refresh();
        const full = inside(dir);
        try {
          return readdirSync(full, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort();
        } catch {
          return [];
        }
      }),
    get: (path) =>
      serial(async () => {
        checkPath(path);
        const have = readLocal(path);
        // Files never change once written, except the heartbeat: always re-read that one from the remote.
        if (have !== undefined && !path.endsWith('heartbeat.json')) return have;
        refresh();
        return readLocal(path);
      }),
  };
}
