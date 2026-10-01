import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatch } from '../src/cli/dispatch.ts';
import { openDb } from '../src/db/db.ts';
import { createProject, createTicket } from '../src/db/queries.ts';
import { workerSdkOptions } from '../src/orchestrator/worker.ts';
import { filesDir, deleteFileEntry, deleteMemory, filePath, listFiles, listMemory, memoryDir, memoryName, readFileEntry, readMemory, writeFileEntry, writeMemory } from '../src/memory/store.ts';
import { memoryPrompt } from '../src/memory/prompt.ts';
import { gitSync, reconcile, refreshKernel } from '../src/memory/sync.ts';
import { prepareKernel } from '../src/core/kernel.ts';

const git = (cwd: string, ...a: string[]) => Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, stdout: 'pipe', stderr: 'pipe' });
let root: string;
let proj: string;
let kern: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'salu-memory-'));
  process.env.SALU_HOME = join(root, 'home');
  process.env.SALU_KERNEL = join(root, 'kernel');
  proj = join(root, 'web');
  mkdirSync(proj);
  git(proj, 'init', '-q', '-b', 'main');
  writeFileSync(join(proj, 'a.txt'), 'one');
  git(proj, 'add', '.');
  git(proj, 'commit', '-qm', 'init');
  kern = prepareKernel('web', proj);
});
afterEach(() => {
  delete process.env.SALU_HOME;
  delete process.env.SALU_KERNEL;
  rmSync(root, { recursive: true, force: true });
});

describe('memory store', () => {
  test('write, read, list, delete', () => {
    const m = writeMemory(proj, { name: 'Build Notes.md', body: 'Run `bun test`.', description: 'how to test', type: 'reference' });
    expect(m.name).toBe('build-notes');
    expect(readMemory(proj, 'build-notes')).toMatchObject({ body: 'Run `bun test`.', description: 'how to test', type: 'reference' });
    expect(listMemory(proj).map((e) => e.name)).toEqual(['build-notes']);
    writeMemory(proj, { name: 'build-notes', body: 'Run `bun test --bail`.' }); // keeps description and type
    expect(readMemory(proj, 'build-notes')).toMatchObject({ description: 'how to test', type: 'reference' });
    expect(deleteMemory(proj, 'build-notes')).toBe(true);
    expect(listMemory(proj)).toEqual([]);
  });
  test('names and paths cannot escape', () => {
    expect(() => memoryName('..')).toThrow();
    expect(memoryName('../../x')).toBe('x');
    expect(() => filePath('../x')).toThrow();
    expect(() => filePath('/etc/passwd')).toThrow();
    expect(() => filePath('a/../../b')).toThrow();
    expect(filePath('a//b/./c.txt')).toBe('a/b/c.txt');
  });
  test('size limits', () => {
    expect(() => writeMemory(proj, { name: 'big', body: 'x'.repeat(9000) })).toThrow('KB');
  });
  test('links inside .salu are never followed', () => {
    writeMemory(proj, { name: 'ok', body: 'fine' });
    writeFileEntry(proj, 'a/b.txt', 'data');
    writeFileSync(join(root, 'secret'), 'top secret');
    symlinkSync(join(root, 'secret'), join(filesDir(proj), 'leak.txt'));
    symlinkSync(root, join(filesDir(proj), 'out'));
    expect(listFiles(proj).map((f) => f.path)).toEqual(['a/b.txt']);
    expect(() => readFileEntry(proj, 'leak.txt')).toThrow('link');
    expect(() => writeFileEntry(proj, 'out/pwn.txt', 'x')).toThrow('link');
    expect(existsSync(join(root, 'pwn.txt'))).toBe(false);
    expect(readFileSync(join(root, 'secret'), 'utf8')).toBe('top secret');
  });
  test('a .salu that is a link yields nothing and refuses writes', () => {
    rmSync(join(proj, '.salu'), { recursive: true, force: true });
    mkdirSync(join(root, 'elsewhere', 'memory'), { recursive: true });
    writeFileSync(join(root, 'elsewhere', 'memory', 'x.md'), 'x');
    symlinkSync(join(root, 'elsewhere'), join(proj, '.salu'));
    expect(listMemory(proj)).toEqual([]);
    expect(() => writeMemory(proj, { name: 'n', body: 'b' })).toThrow('link');
  });
});

describe('worker prompt', () => {
  test('empty memory still explains the layout; small memory is inlined; large is indexed only', () => {
    expect(memoryPrompt(kern)).toContain('.salu/memory');
    expect(memoryPrompt(kern)).toContain('empty so far');
    writeMemory(kern, { name: 'deploy', body: 'Deploys go through the release workflow.', description: 'how we ship' });
    const p = memoryPrompt(kern);
    expect(p).toContain('- deploy (project): how we ship');
    expect(p).toContain('Deploys go through the release workflow.');
    for (let i = 0; i < 4; i++) writeMemory(kern, { name: `big${i}`, body: 'y'.repeat(7000), description: 'long note' });
    const big = memoryPrompt(kern);
    expect(big).toContain('- big0');
    expect(big).not.toContain('y'.repeat(100));
    expect(big).toContain('read the ones that matter');
  });
  test('workerSdkOptions puts it in the system prompt', () => {
    const db = openDb(join(root, 't.db'));
    const project = createProject(db, { name: 'web', path: proj });
    const t = createTicket(db, { project_id: project.id, name: 'x', query: 'q' } as any);
    writeMemory(proj, { name: 'rule', body: 'Always use tabs.' });
    const o = workerSdkOptions({ ...(db.query('select t.*, p.name as project, p.path as project_path from tickets t join projects p on p.id=t.project_id').get() as any) }, project);
    expect((o.systemPrompt as any).append).toContain('Always use tabs.');
    expect(t).toBeTruthy();
  });
});

describe('reconcile', () => {
  test('worker start brings your edits down and leaves the kernel own changes alone', () => {
    writeMemory(proj, { name: 'one', body: 'from you' });
    writeMemory(kern, { name: 'two', body: 'from agent' });
    const r = refreshKernel('web', proj, kern);
    expect(r.toKernel).toEqual(['memory/one.md']);
    expect(readMemory(kern, 'one')?.body).toBe('from you');
    expect(readMemory(proj, 'two')).toBeNull();
    expect(readFileSync(join(kern, '.git', 'info', 'exclude'), 'utf8')).toContain('/.salu/');
  });
  test('sync moves both ways, propagates deletes, and keeps both on conflict', () => {
    writeMemory(proj, { name: 'shared', body: 'v1' });
    writeFileEntry(kern, 'notes/plan.txt', 'agent plan');
    let r = reconcile('web', proj, kern);
    expect(r.toKernel).toEqual(['memory/shared.md']);
    expect(r.toProject).toEqual(['files/notes/plan.txt']);
    expect(readFileEntry(proj, 'notes/plan.txt')?.toString()).toBe('agent plan');
    // both edit
    writeMemory(proj, { name: 'shared', body: 'yours' });
    writeMemory(kern, { name: 'shared', body: 'theirs' });
    r = reconcile('web', proj, kern);
    expect(r.conflicts).toEqual(['memory/shared.md']);
    expect(readMemory(proj, 'shared')?.body).toBe('yours');
    expect(readMemory(kern, 'shared')?.body).toBe('yours');
    const copies = listMemory(proj).map((m) => m.name).filter((n) => n.startsWith('shared.conflict-'));
    expect(copies.length).toBe(1);
    expect(readMemory(proj, copies[0]!)?.body).toBe('theirs');
    expect(listMemory(kern).map((m) => m.name)).toContain(copies[0]!);
    // delete on one side
    deleteFileEntry(kern, 'notes/plan.txt');
    r = reconcile('web', proj, kern);
    expect(r.removed).toEqual(['files/notes/plan.txt']);
    expect(readFileEntry(proj, 'notes/plan.txt')).toBeNull();
    // steady state
    expect(reconcile('web', proj, kern)).toEqual({ toProject: [], toKernel: [], conflicts: [], removed: [], skipped: [] });
  });
  test('a link planted in the kernel is not copied into the project', () => {
    writeFileSync(join(root, 'secret'), 'top secret');
    mkdirSync(filesDir(kern), { recursive: true });
    symlinkSync(join(root, 'secret'), join(filesDir(kern), 'leak.txt'));
    reconcile('web', proj, kern);
    expect(existsSync(join(filesDir(proj), 'leak.txt'))).toBe(false);
  });
  test('a kernel link cannot redirect a write out of the project', () => {
    writeFileEntry(kern, 'd/x.txt', 'x');
    mkdirSync(join(root, 'outside'));
    mkdirSync(filesDir(proj), { recursive: true });
    symlinkSync(join(root, 'outside'), join(filesDir(proj), 'd'));
    expect(reconcile('web', proj, kern).skipped).toEqual(['files/d/x.txt']);
    expect(readdirSync(join(root, 'outside'))).toEqual([]);
  });
  test('dry run changes nothing', () => {
    writeMemory(kern, { name: 'x', body: 'y' });
    const r = reconcile('web', proj, kern, { dryRun: true });
    expect(r.toProject).toEqual(['memory/x.md']);
    expect(readMemory(proj, 'x')).toBeNull();
  });
});

describe('git sync', () => {
  test('commits only .salu, pulls fast-forward, pushes, leaves other changes alone', () => {
    const bare = join(root, 'remote.git');
    git(root, 'init', '-q', '--bare', '-b', 'main', bare);
    git(proj, 'remote', 'add', 'origin', bare);
    git(proj, 'push', '-qu', 'origin', 'main');
    writeFileSync(join(proj, 'a.txt'), 'dirty edit'); // unrelated work in progress
    writeMemory(proj, { name: 'fact', body: 'hello' });
    const r = gitSync(proj);
    expect(r).toMatchObject({ committed: true, pushed: true });
    expect(git(proj, 'status', '--porcelain').stdout.toString().trim()).toBe('M a.txt');
    expect(git(bare, 'show', 'main:.salu/memory/fact.md').stdout.toString()).toContain('hello');
    // another machine pushes memory; we pull it
    const other = join(root, 'other');
    git(root, 'clone', '-q', bare, other);
    writeMemory(other, { name: 'theirs', body: 'from the box' });
    git(other, 'add', '.salu');
    git(other, 'commit', '-qm', 'box memory');
    git(other, 'push', '-q');
    let pulled = false;
    const r2 = gitSync(proj, { afterPull: () => (pulled = true) });
    expect(r2.pulled).toBe(true);
    expect(pulled).toBe(true);
    expect(readMemory(proj, 'theirs')?.body).toBe('from the box');
  });
  test('no remote: commits locally and says so; no repo: says so', () => {
    writeMemory(proj, { name: 'fact', body: 'hello' });
    const r = gitSync(proj);
    expect(r.committed).toBe(true);
    expect(r.notes.join()).toContain('no git remote');
    const plain = join(root, 'plain');
    mkdirSync(plain);
    expect(gitSync(plain).notes.join()).toContain('not a git repository');
  });
});

describe('cli', () => {
  test('memory, files and sync commands', async () => {
    const db = openDb();
    createProject(db, { name: 'web', path: proj });
    const out: string[] = [];
    const log = console.log;
    console.log = (...a: any[]) => void out.push(a.join(' '));
    try {
      expect(await dispatch(['memory', 'add', 'deploy', 'Use the release workflow.', '--project', 'web', '--description', 'shipping'])).toBe(0);
      expect(await dispatch(['memory', '--project', 'web'])).toBe(0);
      expect(await dispatch(['memory', 'show', 'deploy', '--project', 'web'])).toBe(0);
      expect(await dispatch(['files', 'add', 'docs/plan.md', 'the plan', '--project', 'web'])).toBe(0);
      expect(await dispatch(['files', 'get', 'docs/plan.md', '--project', 'web', '--out', join(root, 'plan.out')])).toBe(0);
      expect(readFileSync(join(root, 'plan.out'), 'utf8')).toBe('the plan');
      // an agent writes in the kernel; sync brings it over
      writeMemory(kern, { name: 'agent-note', body: 'learned something' });
      expect(await dispatch(['sync', 'web', '--no-git'])).toBe(0);
      expect(readMemory(proj, 'agent-note')?.body).toBe('learned something');
      expect(readMemory(kern, 'deploy')?.body).toBe('Use the release workflow.');
      expect(await dispatch(['memory', 'rm', 'deploy', '--project', 'web', '--yes'])).toBe(0);
      expect(await dispatch(['sync', 'web'])).toBe(0);
    } finally {
      console.log = log;
    }
    const text = out.join('\n');
    expect(text).toContain('deploy');
    expect(text).toContain('shipping');
    expect(text).toContain('agents → project');
    expect(existsSync(join(proj, '.salu', 'memory', 'deploy.md'))).toBe(false);
    expect(lstatSync(memoryDir(proj)).isDirectory()).toBe(true);
  });
});
