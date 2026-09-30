import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/db.ts';
import { createProject, createTicket } from '../src/db/queries.ts';
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
