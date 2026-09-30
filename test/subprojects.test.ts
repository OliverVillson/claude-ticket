import { beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/db.ts';
import {
  countTickets,
  createProject,
  createTicket,
  deleteProject,
  flattenProjectTree,
  inheritedProject,
  listProjectTree,
  listTickets,
  moveProject,
  projectQualifiedName,
  subtreeIds,
} from '../src/db/queries.ts';
import { ensureProjectChain, newSubproject, projectForNewTicket, resolveProjectRef } from '../src/core/resolve.ts';
import { effectiveSettings } from '../src/orchestrator/worker.ts';
import { Database } from 'bun:sqlite';

let dir: string;
let db: Database;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'salu-sub-'));
  db = openDb(join(dir, 't.db'));
});
const tk = (project_id: number, name: string) => createTicket(db, { status: 'todo', project_id, name, query: 'q', tags: {}, labels: [], priority: 3 });

describe('subprojects', () => {
  test('an old database migrates with every project top level', () => {
    const path = join(dir, 'old.db');
    const old = new Database(path);
    old.exec(`CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, path TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0, default_model TEXT, default_effort TEXT, concurrency INTEGER, created_at INTEGER NOT NULL);
      CREATE TABLE tickets (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, name TEXT NOT NULL, query TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'todo', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      INSERT INTO projects (name, path, created_at) VALUES ('legacy', '/x', 1); PRAGMA user_version = 1;`);
    old.close();
    const migrated = openDb(path);
    expect(migrated.query('SELECT parent_id FROM projects').get()).toEqual({ parent_id: null });
    expect(migrated.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version).toBe(8);
  });

  test('a subproject without a path gets a folder under its parent', () => {
    const parent = createProject(db, { name: 'web', path: join(dir, 'web') });
    const sub = newSubproject(db, parent.id, 'API Server');
    expect(sub.path).toBe(join(dir, 'web', 'api-server'));
    expect(existsSync(sub.path)).toBe(true);
    expect(sub.parent_id).toBe(parent.id);
  });

  test('tree, flatten and qualified names', () => {
    const a = createProject(db, { name: 'a', path: join(dir, 'a') });
    const b = newSubproject(db, a.id, 'b');
    const c = newSubproject(db, b.id, 'c');
    const z = createProject(db, { name: 'z', path: join(dir, 'z') });
    tk(a.id, 't-a');
    tk(b.id, 't-b');
    tk(c.id, 't-c');
    const roots = listProjectTree(db);
    expect(roots.map((r) => r.name)).toEqual(['a', 'z']); // a is the default and sorts first
    expect(roots[0]!.children[0]!.children[0]!.name).toBe('c');
    expect(roots[0]!.counts.todo).toBe(3);
    expect(roots[0]!.own.todo).toBe(1);
    expect(roots[0]!.children[0]!.counts.todo).toBe(2);
    expect(flattenProjectTree(roots).map((n) => `${n.depth}${n.name}`)).toEqual(['0a', '1b', '2c', '0z']);
    expect(flattenProjectTree(roots, (p) => p.name !== 'a').map((n) => n.name)).toEqual(['a', 'z']);
    expect(projectQualifiedName(db, c.id)).toBe('a/b/c');
    expect(subtreeIds(db, a.id).sort()).toEqual([a.id, b.id, c.id].sort());
    expect(subtreeIds(db, z.id)).toEqual([z.id]);
  });

  test('listTickets and countTickets are recursive by default', () => {
    const a = createProject(db, { name: 'a', path: join(dir, 'a') });
    const b = newSubproject(db, a.id, 'b');
    tk(a.id, 'one');
    tk(b.id, 'two');
    expect(listTickets(db, { projectId: a.id }).map((t) => t.name).sort()).toEqual(['one', 'two']);
    expect(listTickets(db, { projectId: a.id, recursive: false }).map((t) => t.name)).toEqual(['one']);
    expect(listTickets(db, { projectId: b.id }).map((t) => t.name)).toEqual(['two']);
    expect(countTickets(db, a.id).todo).toBe(2);
    expect(countTickets(db, a.id, false).todo).toBe(1);
    expect(listTickets(db).length).toBe(2);
  });

  test('the ticket view keeps its own project and folder', () => {
    const a = createProject(db, { name: 'a', path: join(dir, 'a') });
    const b = newSubproject(db, a.id, 'b');
    const t = tk(b.id, 'x');
    expect(t.project).toBe('b');
    expect(t.project_path).toBe(b.path);
  });

  test('moveProject re-parents and refuses cycles', () => {
    const a = createProject(db, { name: 'a', path: join(dir, 'a') });
    const b = newSubproject(db, a.id, 'b');
    const c = newSubproject(db, b.id, 'c');
    expect(() => moveProject(db, a.id, c.id)).toThrow();
    expect(() => moveProject(db, a.id, a.id)).toThrow();
    moveProject(db, c.id, null);
    expect(subtreeIds(db, b.id)).toEqual([b.id]);
    moveProject(db, c.id, a.id);
    expect(projectQualifiedName(db, c.id)).toBe('a/c');
  });

  test('deleting a project removes its subprojects and their tickets', () => {
    const a = createProject(db, { name: 'a', path: join(dir, 'a') });
    const b = newSubproject(db, a.id, 'b');
    const other = createProject(db, { name: 'other', path: join(dir, 'o') });
    tk(b.id, 'gone');
    tk(other.id, 'stays');
    deleteProject(db, a.id);
    expect(listTickets(db).map((t) => t.name)).toEqual(['stays']);
    expect(listProjectTree(db).map((r) => r.name)).toEqual(['other']);
    expect(listProjectTree(db)[0]!.is_default).toBe(1); // a default is handed on
  });

  test('path form resolves and creates missing ancestors', () => {
    const b = ensureProjectChain(db, ['a', 'b', 'c'], dir);
    expect(projectQualifiedName(db, b.id)).toBe('a/b/c');
    expect(b.path).toBe(join(dir, 'a', 'b', 'c'));
    expect(resolveProjectRef(db, 'a/b/c').id).toBe(b.id);
    expect(resolveProjectRef(db, 'b/c').id).toBe(b.id);
    expect(resolveProjectRef(db, 'c').id).toBe(b.id);
    expect(() => resolveProjectRef(db, 'x/c')).toThrow();
    expect(projectForNewTicket(db, 't', 'a/b/c', dir).created).toBe(false);
    expect(projectForNewTicket(db, 't', 'a/n', dir).created).toBe(true);
  });

  test('model and effort defaults inherit from the nearest ancestor', () => {
    const a = createProject(db, { name: 'a', path: join(dir, 'a'), defaultModel: 'sonnet', defaultEffort: 'high' });
    const b = newSubproject(db, a.id, 'b', undefined, { defaultEffort: 'low' });
    const c = newSubproject(db, b.id, 'c');
    const inh = inheritedProject(db, c);
    expect(inh.default_model).toBe('sonnet');
    expect(inh.default_effort).toBe('low');
    const s = effectiveSettings(tk(c.id, 'x'), inh);
    expect(s.model).toBe('sonnet');
    expect(s.effort).toBe('low');
    expect(c.default_model).toBeNull(); // the row itself is untouched
  });
});
