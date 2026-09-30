import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type { Parsed } from '../args.ts';
import { flagBool, flagNum, flagStr } from '../args.ts';
import { openDb } from '../../db/db.ts';
import { getProjectByName, setDefaultProject, updateProject, updateTicket, type TicketPatch } from '../../db/queries.ts';
import { TICKET_STATUSES, type TicketStatus } from '../../db/types.ts';
import { parseTags, validateEffort, validateModel, validatePriority } from '../../core/tags.ts';
import { resolveProject, resolveTicket } from '../../core/resolve.ts';
import { CliError } from '../../core/errors.ts';
import { dim, green } from '../../core/ansi.ts';
import { helpIf, isTTY } from './_shared.ts';

const HELP = `salu change "name" [--name N] [--query Q] [--tags T] [--priority P] [--status S] [--project P] [--id N]
salu change project "name" [--name N] [--path P] [--model M] [--effort E] [--concurrency N] [--default]

Edits one or more fields. --tags replaces the whole tag string. With no flags the ticket
opens in an inline editor. --status todo re-queues a done, failed or blocked ticket.`;

export async function change(p: Parsed): Promise<number> {
  if (helpIf(p, HELP)) return 0;
  const db = openDb();
  if (p.positional[0] === 'project') {
    const name = p.positional[1];
    if (!name) throw new CliError('usage: salu change project "name" [--path P] ...');
    const project = getProjectByName(db, name);
    if (!project) throw new CliError(`no project named "${name}"`);
    const patch: Parameters<typeof updateProject>[2] = {};
    const newName = flagStr(p, 'name');
    if (newName) patch.name = newName;
    const path = flagStr(p, 'path');
    if (path) {
      const abs = resolve(path);
      if (!existsSync(abs)) throw new CliError(`folder does not exist: ${abs}`);
      patch.path = abs;
    }
    const model = flagStr(p, 'model');
    if (model !== undefined) patch.default_model = model ? validateModel(model) : null;
    const effort = flagStr(p, 'effort');
    if (effort !== undefined) patch.default_effort = effort ? validateEffort(effort) : null;
    const conc = flagStr(p, 'concurrency');
    if (conc !== undefined) patch.concurrency = conc ? flagNum(p, 'concurrency')! : null;
    updateProject(db, project.id, patch);
    if (flagBool(p, 'default')) setDefaultProject(db, project.id);
    console.log(`${green('✓')} updated project ${patch.name ?? project.name}`);
    return 0;
  }

  const ref = p.positional[0];
  if (!ref && !flagStr(p, 'id')) throw new CliError('usage: salu change "name" [--name N] [--query Q] [--tags T] [--priority P]');
  const t = resolveTicket(db, ref ?? '', { project: flagStr(p, 'project'), id: flagStr(p, 'id') });

  const patch: TicketPatch = {};
  const newName = flagStr(p, 'name');
  if (newName) patch.name = newName;
  const query = flagStr(p, 'query');
  if (query) patch.query = query;
  const tags = flagStr(p, 'tags');
  if (tags !== undefined) {
    const parsed = parseTags(tags);
    patch.tags = JSON.stringify(parsed.tags);
    patch.labels = JSON.stringify(parsed.labels);
    if (parsed.priority != null) patch.priority = parsed.priority;
    if (parsed.project) patch.project_id = resolveProject(db, parsed.project).id;
  }
  const priority = flagStr(p, 'priority');
  if (priority !== undefined) patch.priority = validatePriority(priority);
  const status = flagStr(p, 'status');
  if (status !== undefined) {
    if (!TICKET_STATUSES.includes(status as TicketStatus)) throw new CliError(`status must be one of ${TICKET_STATUSES.join(', ')}`);
    patch.status = status as TicketStatus;
    if (status === 'todo') {
      patch.error = null;
      patch.finished_at = null;
    }
  }
  const moveTo = flagStr(p, 'move-to') ?? flagStr(p, 'to-project');
  if (moveTo) patch.project_id = resolveProject(db, moveTo).id;

  if (Object.keys(patch).length === 0) {
    if (!isTTY()) throw new CliError('nothing to change: pass --name, --query, --tags, --priority or --status');
    const { openTicketForm } = await import('../../tui/index.tsx');
    await openTicketForm({ ticketId: t.id });
    return 0;
  }
  const updated = updateTicket(db, t.id, patch);
  console.log(`${green('✓')} updated #${updated.id} ${updated.name} ${dim(Object.keys(patch).join(', '))}`);
  return 0;
}
