import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type { Parsed } from '../args.ts';
import { flagBool, flagNum, flagStr } from '../args.ts';
import { openDb } from '../../db/db.ts';
import { createProject, createTicket } from '../../db/queries.ts';
import { parseTags, validateEffort, validateModel, validatePriority } from '../../core/tags.ts';
import { resolveProject } from '../../core/resolve.ts';
import { CliError } from '../../core/errors.ts';
import { dim, green } from '../../core/ansi.ts';
import { helpIf } from './_shared.ts';

const HELP = `ticket add project "name" [path] [--model M] [--effort E] [--concurrency N] [--default]
ticket add "name" "query" ["tags"] [--project P] [--priority N] [--tags T]

Registers a project (path defaults to the current folder; the first project becomes the
default), or adds a ticket to a project. The project for a ticket is taken from the
project=<name> tag or --project, else the project whose folder contains the current
directory, else the default project.`;

export async function add(p: Parsed): Promise<number> {
  if (helpIf(p, HELP)) return 0;
  const db = openDb();
  if (p.positional[0] === 'project') {
    const name = p.positional[1];
    if (!name) throw new CliError('usage: ticket add project "name" [path]');
    const path = resolve(p.positional[2] ?? process.cwd());
    if (!existsSync(path)) throw new CliError(`folder does not exist: ${path}`);
    const model = flagStr(p, 'model');
    const effort = flagStr(p, 'effort');
    const project = createProject(db, {
      name,
      path,
      isDefault: flagBool(p, 'default'),
      defaultModel: model ? validateModel(model) : null,
      defaultEffort: effort ? validateEffort(effort) : null,
      concurrency: flagNum(p, 'concurrency') ?? null,
    });
    console.log(`${green('✓')} project ${project.name} ${dim(`→ ${project.path}`)}${project.is_default ? dim(' (default)') : ''}`);
    return 0;
  }
  const [name, query, ...tagArgs] = p.positional;
  if (!name || !query) throw new CliError('usage: ticket add "name" "query" ["tags"]');
  const tagInput = [...tagArgs];
  const tagsFlag = flagStr(p, 'tags');
  if (tagsFlag) tagInput.push(tagsFlag);
  const parsed = parseTags(tagInput);
  const priorityFlag = flagStr(p, 'priority');
  const priority = priorityFlag !== undefined ? validatePriority(priorityFlag) : (parsed.priority ?? 3);
  const project = resolveProject(db, flagStr(p, 'project') ?? parsed.project);
  const t = createTicket(db, {
    project_id: project.id,
    name,
    query,
    tags: parsed.tags,
    labels: parsed.labels,
    priority,
  });
  console.log(`${green('✓')} #${t.id} ${t.name} ${dim(`in ${project.name}, priority ${t.priority}`)}`);
  return 0;
}
