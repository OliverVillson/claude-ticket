import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allowedDomains, kernelOptions, prepareKernel, sandboxSupport, scrubSecrets, requireHuman } from '../src/core/kernel.ts';
import { workerEnv, workerSdkOptions } from '../src/orchestrator/worker.ts';
import { dispatch } from '../src/cli/dispatch.ts';

const git = (cwd: string, ...a: string[]) => Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, stdout: 'pipe', stderr: 'pipe' });
let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'salu-kernel-'));
  process.env.SALU_KERNEL = join(root, 'kernel');
});
afterAll(() => {
  delete process.env.SALU_KERNEL;
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
    expect(k.sandbox.filesystem?.denyRead).toEqual(['/h']);
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

  test('secrets leave the worker environment but Claude auth stays', () => {
    const env = scrubSecrets({ GITHUB_TOKEN: 'x', GH_TOKEN: 'x', SSH_AUTH_SOCK: '/s', AWS_SECRET_ACCESS_KEY: 'x', ANTHROPIC_API_KEY: 'k', PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 't' });
    expect(Object.keys(env).sort()).toEqual(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'PATH']);
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

  test('every worker is marked, and push/export refuse to run for them', async () => {
    expect(workerEnv().SALU_KERNEL_WORKER).toBe('1');
    process.env.SALU_KERNEL_WORKER = '1';
    try {
      expect(() => requireHuman('push')).toThrow('not for agents');
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
