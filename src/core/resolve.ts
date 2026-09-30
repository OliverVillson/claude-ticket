import type { Database } from 'bun:sqlite';
import type { Project, TicketView } from '../db/types.ts';
import { findProjectForCwd, findTicketsByName, getDefaultProject, getProjectByName, getTicket, getTicketById, listProjects } from '../db/queries.ts';
import { CliError } from './errors.ts';

/**
 * Resolve which project a command means.
 * Order: explicit name > the registered project whose folder contains cwd > the default project.
 */
export function resolveProject(db: Database, name?: string | null, cwd = process.cwd()): Project {
  if (name) {
    const p = getProjectByName(db, name);
    if (!p) throw new CliError(`no project named "${name}" (see \`salu list --projects\`)`);
    return p;
  }
  const byCwd = findProjectForCwd(db, cwd);
  if (byCwd) return byCwd;
  const def = getDefaultProject(db);
  if (def) return def;
  if (listProjects(db).length === 0) throw new CliError('no projects yet: run `salu add project "name" [path]` first');
  throw new CliError('no default project: run `salu add project "name" [path]` or pass project=<name>');
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
