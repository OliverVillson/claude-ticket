import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, openDb } from '../src/db/db.ts';
import { dispatch } from '../src/cli/dispatch.ts';
import { createProject, createTicket, getProjectByName } from '../src/db/queries.ts';
import { folderSlug, projectForNewTicket } from '../src/core/resolve.ts';
import { DEFAULT_EFFORT, DEFAULT_MODEL } from '../src/core/tags.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'salu-seamless-'));
});
afterEach(() => {
  /* temp folders are left to the OS */
});
const fresh = () => openDb(join(dir, 'test.db'));

describe('project for a new ticket', () => {
  test('no projects: creates "<ticket>-proj" with its own folder under cwd', () => {
    const { project, created } = projectForNewTicket(fresh(), 'fix login', null, dir);
    expect(created).toBe(true);
    expect(project.name).toBe('fix-login-proj');
    expect(project.path).toBe(join(dir, 'fix-login-proj'));
    expect(existsSync(project.path)).toBe(true);
  });

  test('inside a known project folder it is selected', () => {
    const db = fresh();
    const p = createProject(db, { name: 'web', path: join(dir, 'web') });
    const r = projectForNewTicket(db, 'x', null, join(dir, 'web', 'src'));
    expect(r.created).toBe(false);
    expect(r.project.id).toBe(p.id);
  });

  test('outside every project a new one is made even when a default exists', () => {
    const db = fresh();
    createProject(db, { name: 'web', path: join(dir, 'web') });
    const r = projectForNewTicket(db, 'docs', null, dir);
    expect(r.created).toBe(true);
    expect(r.project.name).toBe('docs-proj');
    expect(r.project.is_default).toBe(0);
  });

  test('an explicit project that does not exist yet is created; one that exists is reused', () => {
    const db = fresh();
    const a = projectForNewTicket(db, 't', 'blog', dir);
    expect(a.created).toBe(true);
    expect(a.project.path).toBe(join(dir, 'blog'));
    const b = projectForNewTicket(db, 't2', 'blog', dir);
    expect(b.created).toBe(false);
    expect(b.project.id).toBe(a.project.id);
  });

  test('the same ticket name twice reuses its "-proj" project', () => {
    const db = fresh();
    const a = projectForNewTicket(db, 'same', null, dir).project;
    createTicket(db, { status: 'todo', project_id: a.id, name: 'same', query: 'q', tags: {}, labels: [], priority: 3 });
    expect(projectForNewTicket(db, 'same', null, dir).project.id).toBe(a.id);
  });

  test('folderSlug makes safe folder names', () => {
    expect(folderSlug('My App / v2')).toBe('my-app-v2');
    expect(folderSlug('***')).toBe('project');
  });
});

describe('defaults', () => {
  test('workers run on Opus 5.5 at medium effort unless told otherwise', () => {
    expect(DEFAULT_MODEL).toBe('claude-opus-5-5');
    expect(DEFAULT_EFFORT).toBe('medium');
  });
});

describe('add project --clone', () => {
  const git = (cwd: string, ...a: string[]) => Bun.spawnSync(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, stdout: 'pipe', stderr: 'pipe' });
  let origin: string;
  beforeEach(() => {
    origin = join(dir, 'origin-repo');
    mkdirSync(origin);
    git(origin, 'init', '-q', '-b', 'main');
    writeFileSync(join(origin, 'hello.txt'), 'hi');
    git(origin, 'add', '.');
    git(origin, 'commit', '-q', '-m', 'init');
  });
  const add = async (...a: string[]) => {
    const log = console.log;
    const lines: string[] = [];
    console.log = (...x: any[]) => lines.push(x.join(' '));
    try {
      return { code: await dispatch(['add', 'project', ...a]), out: lines.join('\n') };
    } finally {
      console.log = log;
    }
  };
  const env = () => {
    process.env.SALU_HOME = join(dir, 'home');
    closeDb();
  };

  test('clones into the given folder and registers the project', async () => {
    env();
    const dest = join(dir, 'code', 'web');
    const r = await add('web', '--clone', origin, '--path', dest);
    expect(r.code).toBe(0);
    expect(existsSync(join(dest, 'hello.txt'))).toBe(true);
    expect(existsSync(join(dest, '.git'))).toBe(true);
    expect(getProjectByName(openDb(), 'web')!.path).toBe(dest);
  });

  test('a positional path works too, and a subproject lands inside its parent by default', async () => {
    env();
    const dest = join(dir, 'p1');
    expect((await add('parent', dest)).code).toBe(0);
    const cwd = process.cwd();
    const r = await add('child', '--in', 'parent', '--clone', origin);
    expect(r.code).toBe(0);
    expect(existsSync(join(dest, 'origin-repo', 'hello.txt'))).toBe(true); // default folder = repo name, under the parent
    expect(process.cwd()).toBe(cwd);
  });

  test('refuses a folder that already has files, and does not register anything', async () => {
    env();
    const dest = join(dir, 'busy');
    mkdirSync(dest);
    writeFileSync(join(dest, 'keep.txt'), 'x');
    await expect(add('busy', '--clone', origin, '--path', dest)).rejects.toThrow(/already has files/);
    expect(getProjectByName(openDb(), 'busy')).toBeNull();
    expect(readdirSync(dest)).toEqual(['keep.txt']);
  });

  test('a bad URL is a friendly error and leaves no folder behind', async () => {
    env();
    const dest = join(dir, 'nope');
    await expect(add('nope', '--clone', join(dir, 'does-not-exist'), '--path', dest)).rejects.toThrow(/could not clone|git clone failed/);
    expect(existsSync(dest)).toBe(false);
    await expect(add('flag', '--clone', '--evil')).rejects.toThrow();
  });

  test('--clone without a URL, and a missing git, say what to do', async () => {
    env();
    await expect(add('x', '--clone')).rejects.toThrow(/needs a git URL/);
    const path = process.env.PATH;
    process.env.PATH = '/nonexistent';
    try {
      await expect(add('y', '--clone', origin, '--path', join(dir, 'y'))).rejects.toThrow(/git is not installed/);
    } finally {
      process.env.PATH = path;
    }
  });
});
