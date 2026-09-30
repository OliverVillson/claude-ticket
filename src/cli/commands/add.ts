import { join, resolve } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import type { Parsed } from '../args.ts';
import { flagBool, flagNum, flagStr } from '../args.ts';
import { openDb } from '../../db/db.ts';
import { createProject, createTicket } from '../../db/queries.ts';
import { DEFAULT_EFFORT, DEFAULT_MODEL, parseTags, validateEffort, validateModel, validatePriority } from '../../core/tags.ts';
import { ensureProjectChain, folderSlug, projectForNewTicket, resolveProjectRef } from '../../core/resolve.ts';
import { CliError } from '../../core/errors.ts';
import { dim, green } from '../../core/ansi.ts';
import { helpIf } from './_shared.ts';

const HELP = `salu add project "name" [path] [--in parent] [--model M] [--effort E] [--concurrency N] [--default]
salu add "name" "query" ["tags"] [--project P] [--priority N] [--tags T]

Adds a ticket. "query" is optional: when left out, the name is the instruction.
The project is taken from the project=<name> tag or --project (created if it does not exist),
else the registered project whose folder contains the current directory, else a new project
called "<name>-proj" with its own folder under the current directory.

salu add project registers a project. Put it inside another with --in parent (or write the path
form "parent/sub"); a subproject with no path gets a folder under its parent's folder, and its
tickets also show up in every project above it. With no path it uses the current directory when that is
a git repository, otherwise a new folder "./<name>" (created for you). Workers run inside the
project folder, so everything they write lands there.

Workers use ${DEFAULT_MODEL} at effort ${DEFAULT_EFFORT} unless the ticket (model=, effort=) or its project says otherwise.`;

export async function add(p: Parsed): Promise<number> {
  if (helpIf(p, HELP)) return 0;
  const db = openDb();
  if (p.positional[0] === 'project') {
    const rawName = p.positional[1];
    if (!rawName) throw new CliError('usage: salu add project "name" [path] [--in parent]');
    const segs = rawName.split('/').map((x) => x.trim()).filter(Boolean);
    const name = segs[segs.length - 1]!;
    const inFlag = flagStr(p, 'in');
    const parent = inFlag ? resolveProjectRef(db, inFlag) : segs.length > 1 ? ensureProjectChain(db, segs.slice(0, -1)) : null;
    const given = p.positional[2];
    const path = parent
      ? given ? resolve(given) : join(parent.path, folderSlug(name))
      : given ? resolve(given) : existsSync(join(process.cwd(), '.git')) ? process.cwd() : join(process.cwd(), folderSlug(name));
    if (!existsSync(path)) mkdirSync(path, { recursive: true });
    const model = flagStr(p, 'model');
    const effort = flagStr(p, 'effort');
    const project = createProject(db, {
      name,
      path,
      parentId: parent?.id ?? null,
      isDefault: flagBool(p, 'default'),
      defaultModel: model ? validateModel(model) : null,
      defaultEffort: effort ? validateEffort(effort) : null,
      concurrency: flagNum(p, 'concurrency') ?? null,
    });
    console.log(`${green('✓')} project ${parent ? `${parent.name}/` : ''}${project.name} ${dim(`→ ${project.path}`)}${project.is_default ? dim(' (default)') : ''}`);
    return 0;
  }
  const [name, query, ...tagArgs] = p.positional;
  if (!name) throw new CliError('usage: salu add "name" ["query"] ["tags"]   (salu add --help for more)');
  const tagInput = [...tagArgs];
  const tagsFlag = flagStr(p, 'tags');
  if (tagsFlag) tagInput.push(tagsFlag);
  const parsed = parseTags(tagInput);
  const priorityFlag = flagStr(p, 'priority');
  const priority = priorityFlag !== undefined ? validatePriority(priorityFlag) : (parsed.priority ?? 3);
  const { project, created } = projectForNewTicket(db, name, flagStr(p, 'project') ?? parsed.project);
  if (created) console.log(`${green('✓')} project ${project.name} ${dim(`→ ${project.path}`)}`);
  const t = createTicket(db, {
    project_id: project.id,
    name,
    query: query ?? name,
    tags: parsed.tags,
    labels: parsed.labels,
    priority,
  });
  console.log(`${green('✓')} #${t.id} ${t.name} ${dim(`in ${project.name}, priority ${t.priority}`)}`);
  return 0;
}
