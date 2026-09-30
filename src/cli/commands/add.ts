import { join, resolve } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import type { Parsed } from '../args.ts';
import { flagBool, flagNum, flagStr } from '../args.ts';
import { openDb } from '../../db/db.ts';
import { createProject, createTicket, getProjectByName, updateTicket } from '../../db/queries.ts';
import { validateTools } from '../../core/tools.ts';
import { DEFAULT_EFFORT, DEFAULT_MODEL, parseTags, validateEffort, validateModel, validatePriority } from '../../core/tags.ts';
import { ensureProjectChain, folderSlug, projectForNewTicket, resolveProjectRef } from '../../core/resolve.ts';
import { CliError } from '../../core/errors.ts';
import { dim, green } from '../../core/ansi.ts';
import { cloneRepo, repoNameFromUrl } from '../../core/clone.ts';
import { getRemote } from '../../sync/store.ts';
import { publishTicket, syncProject } from '../../sync/sync.ts';
import { helpIf } from './_shared.ts';

const HELP = `salu add "name" ["query"] ["tags"] [--queue]
salu add project "name" [path|--path folder] [--clone git-url] [--in parent] [--model M] [--effort E] [--tools T] [--concurrency N] [--default]
salu add "name" "query" ["tags"] [--project P] [--priority N] [--tags T]

A new ticket is only saved (status backlog): it does not run until you start it with salu queue "name",
salu run, or r in the TUI. --queue saves and queues it in one go.
In a project with a box remote (salu remote add), the ticket is sent to the box, which runs it (--backlog: save it there without running).

Adds a ticket. "query" is optional: when left out, the name is the instruction.
The project is taken from the project=<name> tag or --project (created if it does not exist),
else the registered project whose folder contains the current directory, else a new project
called "<name>-proj" with its own folder under the current directory.

salu add project registers a project. Put it inside another with --in parent (or write the path
form "parent/sub"); a subproject with no path gets a folder under its parent's folder, and its
tickets also show up in every project above it. With no path it uses the current directory when that is
a git repository, otherwise a new folder "./<name>" (created for you). Workers run inside the
project folder, so everything they write lands there.

--clone <git-url> has salu itself clone the repository into the project folder first (the folder
must be new or empty; default ./<repo name>, or inside the parent's folder with --in), then registers
it. It needs git, and a private repo needs you to be logged in (gh auth login or an SSH key).
Example: salu add project web --clone https://github.com/you/web --path ~/code/web

Workers use ${DEFAULT_MODEL} at effort ${DEFAULT_EFFORT} unless the ticket (model=, effort=) or its project says otherwise.
--sandbox runs the project's workers in the kernel: their own copy of the code under ~/.salu/kernel,
with shell commands fenced in by the OS (see salu push / salu export to get the result out).
Tools: tools=standard|readonly|edit|none|allow:Read,Grep,Bash(git *)[;deny:Bash(rm *)] (default standard).`;

export async function add(p: Parsed): Promise<number> {
  if (helpIf(p, HELP)) return 0;
  const db = openDb();
  if (p.positional[0] === 'project') {
    const rawName = p.positional[1];
    if (!rawName) throw new CliError('usage: salu add project "name" [path] [--in parent]');
    const segs = rawName.split('/').map((x) => x.trim()).filter(Boolean);
    const name = segs[segs.length - 1]!;
    const inFlag = flagStr(p, 'in') ?? flagStr(p, 'parent');
    const parent = inFlag ? resolveProjectRef(db, inFlag) : segs.length > 1 ? ensureProjectChain(db, segs.slice(0, -1)) : null;
    const given = p.positional[2] ?? flagStr(p, 'path');
    const cloneUrl = flagStr(p, 'clone');
    if (p.flags.clone !== undefined && !cloneUrl) throw new CliError('--clone needs a git URL: salu add project "name" --clone https://github.com/you/repo [--path folder]');
    if (getProjectByName(db, name)) throw new CliError(`project "${name}" already exists`);
    const slug = folderSlug(cloneUrl ? repoNameFromUrl(cloneUrl) : name);
    const path = parent
      ? given ? resolve(given) : join(parent.path, slug)
      : given ? resolve(given) : cloneUrl ? join(process.cwd(), slug) : existsSync(join(process.cwd(), '.git')) ? process.cwd() : join(process.cwd(), slug);
    if (cloneUrl) cloneRepo(cloneUrl, path, { log: (l) => console.log(dim(l)) });
    else if (!existsSync(path)) mkdirSync(path, { recursive: true });
    const model = flagStr(p, 'model');
    const effort = flagStr(p, 'effort');
    const tools = flagStr(p, 'tools');
    const project = createProject(db, {
      name,
      path,
      parentId: parent?.id ?? null,
      isDefault: flagBool(p, 'default'),
      defaultModel: model ? validateModel(model) : null,
      defaultEffort: effort ? validateEffort(effort) : null,
      defaultTools: tools ? validateTools(tools) : null,
      concurrency: flagNum(p, 'concurrency') ?? null,
      sandbox: flagBool(p, 'sandbox'),
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
  const boxClient = getRemote(db, project.id)?.role === 'client';
  const t = createTicket(db, {
    project_id: project.id,
    name,
    query: query ?? name,
    tags: parsed.tags,
    labels: parsed.labels,
    priority,
    // A ticket for a box is created unclaimable (backlog) and only shown as queued once it is published.
    status: flagBool(p, 'queue') && !boxClient ? 'todo' : 'backlog',
  });
  const remote = getRemote(db, project.id);
  if (remote?.role === 'client') {
    // This project runs on a box: the ticket is sent there (queued unless --backlog) and never runs here.
    const queue = !flagBool(p, 'backlog');
    publishTicket(db, project, t, { queue });
    if (queue) updateTicket(db, t.id, { status: 'todo' });
    try {
      syncProject(db, project, remote);
      console.log(`${green('✓')} #${t.id} ${t.name} ${dim(`sent to ${remote.url}, ${queue ? 'it runs on the box' : 'saved in its backlog'}`)}`);
    } catch (e: any) {
      console.log(`${green('✓')} #${t.id} ${t.name} ${dim('saved; it will be sent on the next `salu remote sync`')}`);
      console.error(`${dim('could not reach the remote now: ' + String(e?.message ?? e))}`);
    }
    return 0;
  }
  console.log(`${green('✓')} #${t.id} ${t.name} ${dim(`in ${project.name}, priority ${t.priority}, ${t.status === 'todo' ? 'queued' : 'saved: `salu queue` or `salu run` starts it'}`)}`);
  return 0;
}
