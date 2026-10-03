import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allowedDomains, cleanScrubStubs, fileToolGuard, fileToolHook, kernelOptions, prepareKernel, sandboxSupport, scrubSecrets, requireHuman, setHumanTty } from '../src/core/kernel.ts';
import { workerEnv, workerSdkOptions } from '../src/orchestrator/worker.ts';
import { dispatch } from '../src/cli/dispatch.ts';

const git = (cwd: string, ...a: string[]) => Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, stdout: 'pipe', stderr: 'pipe' });
let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'salu-kernel-'));
  process.env.SALU_KERNEL = join(root, 'kernel');
  setHumanTty(() => true);
});
afterAll(() => {
  delete process.env.SALU_KERNEL;
  setHumanTty(null);
  rmSync(root, { recursive: true, force: true });
});

describe('kernel', () => {
  test('a git project is cloned into the kernel and edits there leave the real folder alone', () => {
    const proj = join(root, 'web');
    mkdirSync(proj);
    git(proj, 'init', '-q');
    writeFileSync(join(proj, 'a.txt'), 'one');
    git(proj, 'add', '.');
    git(proj, 'commit', '-qm', 'init');
    writeFileSync(join(proj, 'dirty.txt'), 'uncommitted');
    const dir = prepareKernel('web', proj);
    expect(dir).toBe(join(root, 'kernel', 'web'));
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('one');
    expect(existsSync(join(dir, 'dirty.txt'))).toBe(true);
    writeFileSync(join(dir, 'a.txt'), 'changed');
    expect(readFileSync(join(proj, 'a.txt'), 'utf8')).toBe('one');
    expect(prepareKernel('web', proj)).toBe(dir); // reused, not re-copied
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('changed');
  });

  test('a plain folder is copied and made a git repo', () => {
    const proj = join(root, 'plain');
    mkdirSync(proj);
    writeFileSync(join(proj, 'x.txt'), 'x');
    const dir = prepareKernel('plain', proj);
    expect(readFileSync(join(dir, 'x.txt'), 'utf8')).toBe('x');
    expect(existsSync(join(dir, '.git'))).toBe(true);
  });

  test('sandbox options fence writes to the kernel, close the home folder, and fail closed', () => {
    const k = kernelOptions('/k/web', { home: '/h' });
    expect(k.sandbox.enabled).toBe(true);
    expect(k.sandbox.failIfUnavailable).toBe(true);
    expect(k.sandbox.allowUnsandboxedCommands).toBe(false);
    expect(k.sandbox.filesystem?.allowWrite).toEqual(['/k/web']);
    expect(k.sandbox.filesystem?.denyRead).toContain('/h');
    expect(k.sandbox.filesystem?.denyRead).toContain(join(root, 'kernel')); // other projects' kernels
    expect(k.sandbox.filesystem?.allowRead).toContain('/k/web');
    expect(k.disallowedTools).toContain('Read(/h/.ssh/**)');
    expect(k.disallowedTools).toContain('Edit(/h/.gitconfig)');
  });

  test('any site by default; SALU_SANDBOX_DOMAINS narrows it', () => {
    expect(allowedDomains({})).toEqual(['*']);
    expect(allowedDomains({ SALU_SANDBOX_DOMAINS: 'a.com, *.b.com' })).toEqual(['a.com', '*.b.com']);
    expect(kernelOptions('/k', { home: '/h', env: {} }).sandbox.network?.strictAllowlist).toBe(false);
    expect(kernelOptions('/k', { home: '/h', env: { SALU_SANDBOX_DOMAINS: 'a.com' } }).sandbox.network?.strictAllowlist).toBe(true);
  });

  test('a per-project SALU_SANDBOX_DOMAINS_<SLUG> wins over the box-wide list, so projects in one process do not share it', () => {
    const env = { SALU_SANDBOX_DOMAINS: 'box-wide.com', SALU_SANDBOX_DOMAINS_MY_PROJECT: 'only-me.com, *.me.org' };
    // no project, or a project with no key of its own: the box-wide list
    expect(allowedDomains(env)).toEqual(['box-wide.com']);
    expect(allowedDomains(env, 'other')).toEqual(['box-wide.com']);
    // the project with its own key: its own list, not the box-wide one
    expect(allowedDomains(env, 'my project')).toEqual(['only-me.com', '*.me.org']);
    // its allow-list also reaches the in-container sandbox config
    expect(kernelOptions('/k', { home: '/h', env, project: 'my project' }).sandbox.network?.allowedDomains).toEqual(['only-me.com', '*.me.org']);
    // a project with only the box-wide list still gets '*' when neither is set
    expect(allowedDomains({}, 'my project')).toEqual(['*']);
  });

  test('secrets leave the worker environment but Claude auth stays', () => {
    const env = scrubSecrets({ GITHUB_TOKEN: 'x', GH_TOKEN: 'x', SSH_AUTH_SOCK: '/s', AWS_SECRET_ACCESS_KEY: 'x', ANTHROPIC_API_KEY: 'k', PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 't' });
    expect(Object.keys(env).sort()).toEqual(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB', 'PATH']);
  });

  test('the environment is an allow-list: unnamed secrets never get through', () => {
    const env = scrubSecrets({ PATH: '/bin', HOME: '/h', DATABASE_URL: 'x', PGPASSWORD: 'x', STRIPE_SECRET_KEY: 'x', SLACK_BOT_TOKEN: 'x', VERCEL_TOKEN: 'x', CLOUDFLARE_API_TOKEN: 'x', SENTRY_AUTH_TOKEN: 'x', GEMINI_API_KEY: 'x', MY_APP_SECRET: 'x', TF_VAR_password: 'x', LANG: 'C', HTTPS_PROXY: 'p' }, []);
    expect(Object.keys(env).sort()).toEqual(['CLAUDE_CODE_SUBPROCESS_ENV_SCRUB', 'HOME', 'HTTPS_PROXY', 'LANG', 'PATH']);
    expect(scrubSecrets({ DATABASE_URL: 'x' }, ['DATABASE_URL']).DATABASE_URL).toBe('x'); // SALU_ENV_PASS
  });

  test('worker options only get the sandbox when a kernel is given', () => {
    const t: any = { id: 1, name: 't', query: 'q', tags: '{}', labels: '[]', priority: 3, status: 'todo', attempts: 0, project: 'web', project_path: '/real', project_id: 1 };
    expect(workerSdkOptions(t, null).sandbox).toBeUndefined();
    expect(workerSdkOptions(t, null).cwd).toBe('/real');
    const o = workerSdkOptions(t, null, { kernel: '/k/web' });
    expect(o.cwd).toBe('/k/web');
    expect(o.sandbox?.enabled).toBe(true);
    expect(o.disallowedTools).toContain('Bash(git push:*)'); // still there
  });

  test('file tools: writes only in the kernel, reads only kernel and system folders', () => {
    const home = join(root, 'fakehome');
    const k = join(home, '.salu', 'kernel', 'web');
    const other = join(home, '.salu', 'kernel', 'other');
    const real = join(home, 'code', 'web');
    for (const d of [k, other, real, join(home, '.ssh'), join(k, '.git', 'hooks')]) mkdirSync(d, { recursive: true });
    writeFileSync(join(home, '.ssh', 'id_rsa'), 'KEY');
    symlinkSync(join(home, '.ssh'), join(k, 'link'));
    const g = fileToolGuard(k, { home, tmp: join(root, 'tmp') });
    // writes
    expect(g('Write', { file_path: join(k, 'ok.txt') })).toBeNull();
    expect(g('Write', { file_path: 'src/new/deep.ts' })).toBeNull(); // relative, inside
    expect(g('Write', { file_path: join(real, 'a.txt') })).toContain('inside the kernel');
    expect(g('Write', { file_path: join(home, '.zshenv') })).toContain('inside the kernel');
    expect(g('Edit', { file_path: '~/.claude/settings.json' })).toContain('inside the kernel');
    expect(g('Write', { file_path: join(k, '..', '..', '..', 'code', 'web', 'a.txt') })).toContain('inside the kernel'); // ../
    expect(g('Write', { file_path: join(k, 'link', 'x') })).toContain('inside the kernel'); // symlink out
    expect(g('Write', { file_path: join(k, '.git', 'hooks', 'pre-push') })).toContain('inside the kernel');
    expect(g('Write', { file_path: join(k, '.git', 'config') })).toContain('inside the kernel');
    expect(g('NotebookEdit', { notebook_path: join(real, 'n.ipynb') })).toContain('inside the kernel');
    // links whose target does not exist yet, chains and loops
    symlinkSync(join(home, '.zshenv'), join(k, 'notes.txt'));
    symlinkSync(join(real, 'new.txt'), join(k, 'dangling-real'));
    symlinkSync(join(k, 'dangling-real'), join(k, 'chain'));
    symlinkSync(join(k, 'loop-b'), join(k, 'loop-a'));
    symlinkSync(join(k, 'loop-a'), join(k, 'loop-b'));
    symlinkSync(join(k, 'inside-target.txt'), join(k, 'inside-link'));
    symlinkSync('../../../../.zshenv', join(k, 'relative-dangling'));
    expect(g('Write', { file_path: join(k, 'notes.txt') })).toContain('inside the kernel'); // dangling link to ~/.zshenv
    expect(g('Write', { file_path: 'notes.txt' })).toContain('inside the kernel');
    expect(g('Write', { file_path: join(k, 'dangling-real') })).toContain('inside the kernel'); // into the real project
    expect(g('Write', { file_path: join(k, 'chain') })).toContain('inside the kernel');
    expect(g('Write', { file_path: join(k, 'relative-dangling') })).toContain('inside the kernel');
    expect(g('Write', { file_path: join(k, 'loop-a') })).toContain('inside the kernel');
    expect(g('Read', { file_path: join(k, 'loop-a') })).toContain('only read');
    expect(g('Write', { file_path: join(k, 'inside-link') })).toBeNull(); // a link that stays inside is fine
    expect(g('Write', { file_path: join(k, 'notes.txt', 'sub') })).toContain('inside the kernel');
    // hard links to files outside the kernel
    linkSync(join(home, '.ssh', 'id_rsa'), join(k, 'hard'));
    expect(g('Read', { file_path: join(k, 'hard') })).toContain('hard links');
    expect(g('Write', { file_path: join(k, 'hard') })).toContain('hard links');
    expect(g('Edit', { file_path: 'hard' })).toContain('hard links');
    writeFileSync(join(k, 'plain.txt'), 'x');
    expect(g('Read', { file_path: join(k, 'plain.txt') })).toBeNull(); // ordinary files unaffected
    // reads
    expect(g('Read', { file_path: join(k, 'a.txt') })).toBeNull();
    expect(g('Read', { file_path: '/usr/lib/x' })).toBeNull();
    expect(g('Read', { file_path: join(home, '.ssh', 'id_rsa') })).toContain('only read');
    expect(g('Read', { file_path: join(home, '.claude', 'projects', 'p', 's', 'tool-results', 'out.txt') })).toBeNull(); // saved command output
    expect(g('Read', { file_path: join(home, '.claude', 'projects', 'p', 's.jsonl') })).toContain('only read');
    expect(g('Read', { file_path: join(home, '.config', 'gcloud', 'credentials.db') })).toContain('only read');
    expect(g('Read', { file_path: join(home, '.bash_history') })).toContain('only read');
    expect(g('Read', { file_path: join(other, 'src.ts') })).toContain('only read'); // another project's kernel
    expect(g('Read', { file_path: '../../../.ssh/id_rsa' })).toContain('only read');
    expect(g('Read', { file_path: join(k, 'link', 'id_rsa') })).toContain('only read');
    expect(g('Grep', { pattern: 'KEY', path: join(home, '.ssh') })).toContain('only read');
    expect(g('Glob', { pattern: '../../../.ssh/*' })).toContain('leaves the kernel');
    expect(g('Glob', { pattern: '/etc/*' })).toContain('leaves the kernel');
    expect(g('Grep', { pattern: 'x', glob: '../*' })).toContain('leaves the kernel');
    expect(g('Grep', { pattern: 'x' })).toBeNull();
    expect(g('Bash', { command: 'ls' })).toBeNull();
  });

  test('the hook denies with a reason, and denies when the check itself breaks', async () => {
    const hook = fileToolHook(join(root, 'kernel', 'web'), { home: join(root, 'fakehome') });
    const base: any = { hook_event_name: 'PreToolUse', tool_use_id: 't' };
    const denied: any = await hook({ ...base, tool_name: 'Write', tool_input: { file_path: '/etc/passwd' } }, undefined, { signal: new AbortController().signal });
    expect(denied.hookSpecificOutput.permissionDecision).toBe('deny');
    const ok: any = await hook({ ...base, tool_name: 'Read', tool_input: { file_path: join(root, 'kernel', 'web', 'a') } }, undefined, { signal: new AbortController().signal });
    expect(ok).toEqual({});
    const weird: any = await hook({ ...base, tool_name: 'Read', tool_input: { file_path: 'a\0b' } }, undefined, { signal: new AbortController().signal });
    expect(weird.hookSpecificOutput?.permissionDecision ?? 'deny').toBe('deny');
  });

  test('worker options carry the hook and the allow-listed environment', () => {
    const t: any = { id: 1, name: 't', query: 'q', tags: '{}', labels: '[]', priority: 3, status: 'todo', attempts: 0, project: 'web', project_path: '/real', project_id: 1 };
    process.env.STRIPE_SECRET_KEY = 'x';
    try {
      const o = workerSdkOptions(t, null, { kernel: '/k/web' });
      expect(o.hooks?.PreToolUse?.length).toBe(1);
      expect(o.env?.STRIPE_SECRET_KEY).toBeUndefined();
      expect(o.env?.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe('1');
    } finally {
      delete process.env.STRIPE_SECRET_KEY;
    }
  });

  test('push/export need a real terminal, and never run for a worker', async () => {
    setHumanTty(() => false);
    try {
      await expect(dispatch(['push'])).rejects.toThrow('not for agents');
      await expect(dispatch(['export', join(root, 'out2')])).rejects.toThrow('not for agents');
    } finally {
      setHumanTty(() => true);
    }
  });

  test('--yes lets kernel setup run without a terminal, but only for a person', () => {
    setHumanTty(() => false);
    try {
      expect(() => requireHuman('kernel setup')).toThrow('not for agents');
      expect(() => requireHuman('kernel setup', { yes: true })).not.toThrow();
    } finally {
      setHumanTty(() => true);
    }
  });

  test('every worker is marked, and push/export refuse to run for them', async () => {
    expect(workerEnv().SALU_KERNEL_WORKER).toBe('1');
    process.env.SALU_KERNEL_WORKER = '1';
    try {
      expect(() => requireHuman('push')).toThrow('not for agents');
      expect(() => requireHuman('kernel setup', { yes: true })).toThrow('not for agents'); // --yes is for ssh scripts, never for a worker
      await expect(dispatch(['push'])).rejects.toThrow('not for agents');
      await expect(dispatch(['export', join(root, 'out')])).rejects.toThrow('not for agents');
    } finally {
      delete process.env.SALU_KERNEL_WORKER;
    }
  });

  test('sandbox support message on Linux names what is missing', () => {
    expect(sandboxSupport('darwin').ok).toBe(true);
    expect(sandboxSupport('linux', () => null).problem).toContain('bubblewrap and socat');
    expect(sandboxSupport('linux', () => '/usr/bin/x').ok).toBe(true);
    expect(sandboxSupport('win32').ok).toBe(false);
  });
});

describe('salu push and export', () => {
  test('push sends salu/* branches to a remote, export copies files out', async () => {
    const home = join(root, 'home');
    process.env.SALU_HOME = home;
    const { closeDb } = await import('../src/db/db.ts');
    closeDb();
    try {
      const proj = join(root, 'app');
      mkdirSync(proj);
      git(proj, 'init', '-q');
      writeFileSync(join(proj, 'a.txt'), 'one');
      git(proj, 'add', '.');
      git(proj, 'commit', '-qm', 'init');
      const remote = join(root, 'remote.git');
      Bun.spawnSync(['git', 'init', '-q', '--bare', remote]);
      expect(await dispatch(['add', 'project', 'app', proj])).toBe(0);
      const dir = prepareKernel('app', proj);
      git(dir, 'checkout', '-qb', 'salu/fix');
      writeFileSync(join(dir, 'b.txt'), 'two');
      git(dir, 'add', '.');
      git(dir, 'commit', '-qm', 'agent work');
      expect(await dispatch(['push', 'app', '--to', remote])).toBe(0);
      expect(Bun.spawnSync(['git', 'branch', '--list'], { cwd: remote, stdout: 'pipe' }).stdout.toString()).toContain('salu/fix');
      const out = join(root, 'out');
      expect(await dispatch(['export', out, 'app'])).toBe(0);
      expect(readFileSync(join(out, 'b.txt'), 'utf8')).toBe('two');
      expect(existsSync(join(out, '.git'))).toBe(false);
      await expect(dispatch(['export', out, 'app'])).rejects.toThrow('not empty');
    } finally {
      closeDb();
      delete process.env.SALU_HOME;
    }
  });
});

describe('the stand-ins left by the bubblewrap scrub', () => {
  test('empty untracked ones are removed; real, non-empty or committed ones stay', () => {
    const d = mkdtempSync(join(tmpdir(), 'salu-stubs-'));
    git(d, 'init', '-q');
    writeFileSync(join(d, '.env'), '');
    writeFileSync(join(d, '.env.local'), '');
    writeFileSync(join(d, 'package.json'), '');
    writeFileSync(join(d, 'bunfig.toml'), 'x = 1\n'); // has content: stays
    writeFileSync(join(d, '.npmrc'), ''); // committed empty: stays
    git(d, 'add', '.npmrc');
    git(d, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x');
    mkdirSync(join(d, 'node_modules'));
    mkdirSync(join(d, '.claude'));
    writeFileSync(join(d, '.claude', 'settings.json'), '{}'); // not empty: stays
    const removed = cleanScrubStubs(d).sort();
    expect(removed).toEqual(['.env', '.env.local', 'node_modules/', 'package.json']);
    expect(existsSync(join(d, 'bunfig.toml'))).toBe(true);
    expect(existsSync(join(d, '.npmrc'))).toBe(true);
    expect(existsSync(join(d, '.claude'))).toBe(true);
    rmSync(d, { recursive: true, force: true });
  });
});
