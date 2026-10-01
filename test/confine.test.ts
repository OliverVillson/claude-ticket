import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cacheEnv, confinementFor, credentialPaths, workerCacheDir, fileToolGuard, fileToolHook, kernelOptions } from '../src/core/kernel.ts';
import { CONFINED_ALLOWED_TOOLS, DEFAULT_ALLOWED_TOOLS, SALU_TOOLS, parseTools, toolsToSdk } from '../src/core/tools.ts';
import { workerSdkOptions } from '../src/orchestrator/worker.ts';

let root: string;
let home: string;
let proj: string;
let outside: string;
const ticket: any = { id: 1, name: 't', query: 'q', tags: '{}', labels: '[]', priority: 3, status: 'todo', attempts: 0, project: 'web', project_id: 1 };

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'salu-confine-'));
  home = join(root, 'home');
  proj = join(home, 'code', 'web');
  outside = join(home, 'code', 'other');
  for (const d of [proj, outside, join(home, '.ssh'), join(proj, '.git', 'hooks'), join(proj, '.claude')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(home, '.ssh', 'id_rsa'), 'KEY');
  writeFileSync(join(home, '.gitconfig'), '[user]');
  ticket.project_path = proj;
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('confinement default', () => {
  test('every project is fenced; project.sandbox means its own copy; SALU_SANDBOX=off is the only way out', () => {
    expect(confinementFor(null, {})).toBe('fence');
    expect(confinementFor({ sandbox: 0 }, {})).toBe('fence');
    expect(confinementFor({ sandbox: 1 }, {})).toBe('kernel');
    expect(confinementFor({ sandbox: 1 }, { SALU_SANDBOX: 'off' })).toBe('off');
    expect(confinementFor({ sandbox: 0 }, { SALU_SANDBOX: 'off' })).toBe('off');
  });
});

describe('writes outside the project are refused (file tools)', () => {
  const g: ReturnType<typeof fileToolGuard> = (tool, input) => fileToolGuard(proj, { home, tmp: join(root, 'tmp'), fence: true })(tool, input);
  test('Write, Edit and NotebookEdit refuse paths outside the project folder', () => {
    for (const tool of ['Write', 'Edit', 'MultiEdit']) {
      expect(g(tool, { file_path: join(proj, 'src', 'ok.ts') })).toBeNull();
      expect(g(tool, { file_path: join(outside, 'a.txt') })).toContain('inside the project folder');
      expect(g(tool, { file_path: join(home, '.zshenv') })).toContain('inside the project folder');
      expect(g(tool, { file_path: '/etc/hosts' })).toContain('inside the project folder');
      expect(g(tool, { file_path: '../other/a.txt' })).toContain('inside the project folder'); // relative, climbs out
      expect(g(tool, { file_path: '~/.bashrc' })).toContain('inside the project folder');
    }
    expect(g('NotebookEdit', { notebook_path: join(outside, 'n.ipynb') })).toContain('inside the project folder');
  });

  test('links cannot be used to climb out, and the places that run code later stay read-only', () => {
    symlinkSync(outside, join(proj, 'out-link'));
    symlinkSync(join(home, '.zshenv'), join(proj, 'dangling'));
    linkSync(join(home, '.ssh', 'id_rsa'), join(proj, 'hard'));
    expect(g('Write', { file_path: join(proj, 'out-link', 'x.txt') })).toContain('inside the project folder');
    expect(g('Write', { file_path: join(proj, 'dangling') })).toContain('inside the project folder');
    expect(g('Write', { file_path: join(proj, 'hard') })).toContain('hard links');
    expect(g('Write', { file_path: join(proj, '.git', 'hooks', 'pre-commit') })).toContain('inside the project folder');
    expect(g('Write', { file_path: join(proj, '.git', 'config') })).toContain('inside the project folder');
    expect(g('Write', { file_path: join(proj, '.claude', 'settings.json') })).toContain('inside the project folder');
    expect(g('Write', { file_path: join(proj, '.mcp.json') })).toContain('inside the project folder');
  });

  test('reads stay open (a worker needs its tools and git identity) except credential stores', () => {
    expect(g('Read', { file_path: join(outside, 'a.txt') })).toBeNull();
    expect(g('Read', { file_path: join(home, '.gitconfig') })).toBeNull();
    expect(g('Glob', { pattern: '/usr/lib/*' })).toBeNull();
    expect(g('Read', { file_path: join(home, '.ssh', 'id_rsa') })).toContain('credential');
    expect(g('Grep', { pattern: 'KEY', path: join(home, '.ssh') })).toContain('credential');
    symlinkSync(join(home, '.ssh'), join(proj, 'cred-link'));
    expect(g('Read', { file_path: join(proj, 'cred-link', 'id_rsa') })).toContain('credential'); // through a link
  });

  test('the hook turns every refusal into a deny, and lets inside writes through', async () => {
    const hook = fileToolHook(proj, { home, tmp: join(root, 'tmp'), fence: true });
    const base: any = { hook_event_name: 'PreToolUse', tool_use_id: 't' };
    const run = (tool_name: string, tool_input: unknown): Promise<any> => hook({ ...base, tool_name, tool_input }, undefined, { signal: new AbortController().signal }) as any;
    expect((await run('Write', { file_path: join(outside, 'x') })).hookSpecificOutput.permissionDecision).toBe('deny');
    expect((await run('Edit', { file_path: join(home, '.zshrc') })).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(await run('Write', { file_path: join(proj, 'new.txt') })).toEqual({});
  });
});

describe('what a fenced worker is started with', () => {
  test('writes are confined to the project in the OS sandbox and the hook; credentials are closed; the environment is scrubbed', () => {
    process.env.STRIPE_SECRET_KEY = 'x';
    try {
      const o = workerSdkOptions(ticket, null, { fence: { osSandbox: true } });
      expect(o.cwd).toBe(proj); // the real project, not a copy
      expect(o.sandbox?.enabled).toBe(true);
      expect(o.sandbox?.filesystem?.allowWrite).toEqual([proj, workerCacheDir('web')]); // the project, and a private package cache
      expect(o.sandbox?.filesystem?.denyRead).toEqual(credentialPaths());
      expect(o.sandbox?.allowUnsandboxedCommands).toBe(false);
      expect(o.hooks?.PreToolUse?.length).toBe(1);
      expect(o.env?.STRIPE_SECRET_KEY).toBeUndefined();
      expect(o.settingSources).toEqual(['user', 'project', 'local']);
      expect(o.disallowedTools).toContain('Bash(git push:*)');
      for (const t of CONFINED_ALLOWED_TOOLS) expect(o.allowedTools).toContain(t);
    } finally {
      delete process.env.STRIPE_SECRET_KEY;
    }
  });

  test('without the OS sandbox the file fence stays and shell rules stay narrow', () => {
    const o = workerSdkOptions(ticket, null, { fence: { osSandbox: false } });
    expect(o.sandbox).toBeUndefined();
    expect(o.hooks?.PreToolUse?.length).toBe(1);
    expect(o.allowedTools).toEqual(DEFAULT_ALLOWED_TOOLS);
    expect(o.allowedTools).not.toContain('Bash');
  });

  test('a kernel worker also gets the full toolset; an unconfined one (SALU_SANDBOX=off) keeps the narrow rules', () => {
    expect(workerSdkOptions(ticket, null, { kernel: '/k/web' }).allowedTools).toContain('WebFetch');
    const none = workerSdkOptions(ticket, null);
    expect(none.sandbox).toBeUndefined();
    expect(none.hooks).toBeUndefined();
    expect(none.allowedTools).toEqual(DEFAULT_ALLOWED_TOOLS);
  });

  test('the fence option set differs from the kernel only in reads', () => {
    const k = kernelOptions(proj, { home, mode: 'fence' });
    expect(k.sandbox.filesystem?.allowWrite).toEqual([proj]);
    expect(k.sandbox.filesystem?.allowRead).toBeUndefined();
    expect(k.disallowedTools).toContain(`Read(${join(home, '.ssh')}/**)`);
    expect(k.disallowedTools).not.toContain(`Read(${join(home, '.gitconfig')})`);
  });
});

describe('tools in confined mode', () => {
  test('presets that limit the shell or the web are not widened', () => {
    expect(toolsToSdk('edit', 'acceptEdits', { confined: true }).allowedTools).toEqual(DEFAULT_ALLOWED_TOOLS);
    expect(toolsToSdk('readonly', 'acceptEdits', { confined: true }).tools).not.toContain('Bash');
    expect(toolsToSdk('none', 'acceptEdits', { confined: true }).allowedTools).toEqual([]);
    expect(toolsToSdk('allow:Read,Grep', 'acceptEdits', { confined: true }).allowedTools).toEqual(['Read', 'Grep']);
  });

  test('MCP tool rules are accepted, hyphens and all, and stay a per-tool decision', () => {
    expect(parseTools('also:mcp__claude-code-remote__list_repos,mcp__github').also).toEqual(['mcp__claude-code-remote__list_repos', 'mcp__github']);
    const o = toolsToSdk('standard', 'acceptEdits', { confined: true });
    // salu's own in-process tool is allowed by name, in every mode; servers from .mcp.json are not
    expect(o.allowedTools?.filter((r) => r.startsWith('mcp__'))).toEqual(SALU_TOOLS);
    expect(toolsToSdk('standard', 'acceptEdits').allowedTools).toEqual(expect.arrayContaining(SALU_TOOLS));
    expect(o.allowedTools).not.toContain('mcp__github');
    expect(toolsToSdk('also:mcp__github', 'acceptEdits', { confined: true }).allowedTools).toContain('mcp__github');
  });
});

describe('running what it builds: caches, temp, dev servers', () => {
  test('package-manager caches go to a private per-project folder, the only extra place a worker may write', () => {
    process.env.SALU_CACHE = join(root, 'cache');
    try {
      const o = workerSdkOptions(ticket, null, { fence: { osSandbox: true } });
      const cache = workerCacheDir('web');
      expect(cache).toBe(join(root, 'cache', 'web'));
      expect(o.sandbox?.filesystem?.allowWrite).toEqual([proj, cache]);
      for (const k of ['BUN_INSTALL_CACHE_DIR', 'npm_config_cache', 'PIP_CACHE_DIR', 'UV_CACHE_DIR', 'YARN_CACHE_FOLDER', 'CARGO_HOME', 'GOCACHE']) expect(o.env?.[k]?.startsWith(cache + '/')).toBe(true);
      for (const v of Object.values(cacheEnv(cache))) expect(v.startsWith(cache + '/')).toBe(true);
      // the user's own caches stay closed: nothing in the home folder is writable, and the file tools still refuse them
      expect(o.sandbox?.filesystem?.allowWrite?.filter((p) => p !== proj).some((p) => p.startsWith(home))).toBe(false);
      expect(fileToolGuard(proj, { home, tmp: join(root, 'tmp'), fence: true })('Write', { file_path: join(home, '.bun', 'install', 'cache', 'x') })).toContain('inside the project folder');
      expect(fileToolGuard(proj, { home, tmp: join(root, 'tmp'), fence: true })('Write', { file_path: join(cache, 'x') })).toContain('inside the project folder'); // shell only
      const k = workerSdkOptions(ticket, null, { kernel: '/k/web' });
      expect(k.sandbox?.filesystem?.allowRead).toContain(cache); // the kernel closes the home folder, the cache is under it
    } finally {
      delete process.env.SALU_CACHE;
    }
  });

  test('a dev server may listen on localhost, and unconfined or unsandboxed workers get no cache redirect', () => {
    expect(workerSdkOptions(ticket, null, { fence: { osSandbox: true } }).sandbox?.network?.allowLocalBinding).toBe(true);
    expect(workerSdkOptions(ticket, null, { fence: { osSandbox: false } }).env?.npm_config_cache).toBeUndefined();
    expect(workerSdkOptions(ticket, null).env?.npm_config_cache).toBeUndefined();
  });

  // The same mount layout Claude Code's sandbox builds (read-only root, project and cache writable, private temp), run for real.
  const bwrap = Bun.which('bwrap');
  test.skipIf(!bwrap)('under a bubblewrap with that layout: caches, temp and the project are writable, the home folder is not', () => {
    const cache = join(root, 'wcache', 'web');
    const tmp = join(root, 'wtmp');
    mkdirSync(cache, { recursive: true });
    mkdirSync(tmp, { recursive: true });
    const sh = (script: string) => Bun.spawnSync([bwrap!, '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--bind', proj, proj, '--bind', cache, cache, '--bind', tmp, tmp, '--setenv', 'TMPDIR', tmp, '--chdir', proj, 'sh', '-c', script], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
    const ok = (script: string) => sh(script).exitCode === 0;
    expect(ok(`echo a > ${proj}/built.txt && echo b > ${cache}/npm-cache && echo c > $TMPDIR/t`)).toBe(true);
    expect(ok(`echo x > ${home}/.bun-cache-poison`)).toBe(false);
    expect(ok(`echo x > ${outside}/escape.txt`)).toBe(false);
    expect(ok(`echo x > ${join(home, '.ssh', 'authorized_keys')}`)).toBe(false);
  });
});
