import type { Database } from 'bun:sqlite';
import type { Project, TicketView } from '../db/types.ts';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createProject, findProjectForCwd, getProjectById, projectQualifiedName, findTicketsByName, getDefaultProject, getProjectByName, getTicket, getTicketById, listProjects } from '../db/queries.ts';
import { CliError } from './errors.ts';

/**
 * Resolve which project a command means.
 * Order: explicit name > the registered project whose folder contains cwd > the default project.
 */
export function resolveProject(db: Database, name?: string | null, cwd = process.cwd()): Project {
  if (name) return resolveProjectRef(db, name);
  const byCwd = findProjectForCwd(db, cwd);
  if (byCwd) return byCwd;
  const def = getDefaultProject(db);
  if (def) return def;
  if (listProjects(db).length === 0) throw new CliError('nothing here yet: run `salu add "what you want done"` and salu makes the project for you');
  throw new CliError('no default project: run `salu add project "name" [path]` or pass project=<name>');
}

/**
 * A project by name, or by path `parent/sub` (names are globally unique, so the last segment
 * finds the project and the rest is checked against its ancestors).
 */
export function resolveProjectRef(db: Database, ref: string): Project {
  const parts = ref.split('/').map((s) => s.trim()).filter(Boolean);
  const last = parts[parts.length - 1];
  const p = last ? getProjectByName(db, last) : null;
  if (!p) throw new CliError(`no project named "${ref}" (see \`salu list --projects\`)`);
  if (parts.length > 1 && projectQualifiedName(db, p.id) !== parts.join('/') && !projectQualifiedName(db, p.id).endsWith('/' + parts.join('/')))
    throw new CliError(`"${last}" is in ${projectQualifiedName(db, p.id)}, not in ${parts.slice(0, -1).join('/')}`);
  return p;
}

/** Walks `a/b/c`, creating any project that does not exist yet (top level under cwd, the rest as subprojects); returns the last. */
export function ensureProjectChain(db: Database, segments: string[], cwd = process.cwd()): Project {
  let cur: Project | null = null;
  for (const seg of segments) {
    const existing = getProjectByName(db, seg);
    if (existing) {
      if ((existing.parent_id ?? null) !== (cur?.id ?? null)) throw new CliError(`"${seg}" is already a project in ${projectQualifiedName(db, existing.id)}`);
      cur = existing;
    } else {
      cur = cur ? newSubproject(db, cur.id, seg) : newProjectInFolder(db, seg, cwd);
    }
  }
  if (!cur) throw new CliError('empty project name');
  return cur;
}

/** A subproject of `parentId`. The folder defaults to `<parent folder>/<slug(name)>` and is created. */
export function newSubproject(db: Database, parentId: number, name: string, path?: string, extra: { defaultModel?: string | null; defaultEffort?: string | null; concurrency?: number | null } = {}): Project {
  const parent = getProjectById(db, parentId);
  if (!parent) throw new CliError(`no project with id ${parentId}`);
  const dir = path ?? join(parent.path, folderSlug(name));
  mkdirSync(dir, { recursive: true });
  return createProject(db, { name, path: dir, parentId, ...extra });
}

/** `my ticket` -> `my-ticket`: a safe folder name. */
export function folderSlug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
}

/**
 * The project a new ticket goes to, without ever failing for lack of one.
 * Order: explicit name (created when it does not exist yet) > the registered project whose folder
 * contains cwd > a new project named `<ticket>-proj` with its own folder under cwd.
 */
export function projectForNewTicket(db: Database, ticketName: string, explicit?: string | null, cwd = process.cwd()): { project: Project; created: boolean } {
  const name = explicit || undefined;
  if (name?.includes('/')) {
    const segs = name.split('/').map((s) => s.trim()).filter(Boolean);
    const existed = !!getProjectByName(db, segs[segs.length - 1] ?? '');
    return { project: ensureProjectChain(db, segs, cwd), created: !existed };
  }
  if (name) {
    const p = getProjectByName(db, name);
    return p ? { project: p, created: false } : { project: newProjectInFolder(db, name, cwd), created: true };
  }
  const byCwd = findProjectForCwd(db, cwd);
  if (byCwd) return { project: byCwd, created: false };
  const auto = `${folderSlug(ticketName)}-proj`;
  const existing = getProjectByName(db, auto);
  return existing ? { project: existing, created: false } : { project: newProjectInFolder(db, auto, cwd), created: true };
}

/** Creates a project whose folder is `<cwd>/<name>` (made if missing). */
export function newProjectInFolder(db: Database, name: string, cwd = process.cwd()): Project {
  const path = join(cwd, folderSlug(name));
  mkdirSync(path, { recursive: true });
  return createProject(db, { name, path });
}

/**
 * Resolve a ticket by name (or `--id`). When no project is given and the name is unique across
 * projects, that ticket is used; otherwise the project is resolved as for any command.
 */
export function resolveTicket(db: Database, ref: string, opts: { project?: string | null; id?: number | string | null; cwd?: string } = {}): TicketView {
  if (opts.id != null && opts.id !== '') {
    const id = Number(opts.id);
    const t = Number.isInteger(id) ? getTicketById(db, id) : null;
    if (!t) throw new CliError(`no ticket with id ${opts.id}`);
    return t;
  }
  if (opts.project) {
    const p = resolveProject(db, opts.project, opts.cwd);
    const t = getTicket(db, p.id, ref);
    if (!t) throw new CliError(`no ticket named "${ref}" in project "${p.name}"`);
    return t;
  }
  const matches = findTicketsByName(db, ref);
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) {
    if (/^#?\d+$/.test(ref)) {
      const t = getTicketById(db, Number(ref.replace('#', '')));
      if (t) return t;
    }
    throw new CliError(`no ticket named "${ref}"`);
  }
  // Ambiguous: prefer the project resolved from cwd / default.
  try {
    const p = resolveProject(db, null, opts.cwd);
    const t = matches.find((m) => m.project_id === p.id);
    if (t) return t;
  } catch {
    /* fall through */
  }
  throw new CliError(
    `"${ref}" exists in several projects (${matches.map((m) => m.project).join(', ')}); pass project=<name> or --id <id>`,
  );
}
