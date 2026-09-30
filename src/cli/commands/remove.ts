import type { Parsed } from '../args.ts';
import { flagStr } from '../args.ts';
import { openDb } from '../../db/db.ts';
import { countTickets, deleteProject, deleteTicket, getProjectByName } from '../../db/queries.ts';
import { resolveTicket } from '../../core/resolve.ts';
import { CliError } from '../../core/errors.ts';
import { dim, green } from '../../core/ansi.ts';
import { confirm, helpIf } from './_shared.ts';

const HELP = `salu remove "name" [--yes] [--project P] [--id N]
salu remove project "name" [--yes]

Deletes a ticket (a running one is stopped first) or a project with all its tickets.`;

export async function remove(p: Parsed): Promise<number> {
  if (helpIf(p, HELP)) return 0;
  const db = openDb();
  if (p.positional[0] === 'project') {
    const name = p.positional[1];
    if (!name) throw new CliError('usage: salu remove project "name"');
    const project = getProjectByName(db, name);
    if (!project) throw new CliError(`no project named "${name}"`);
    const counts = countTickets(db, project.id);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (!(await confirm(p, `Delete project "${project.name}" and its ${total} ticket${total === 1 ? '' : 's'}?`))) return 1;
    deleteProject(db, project.id);
    console.log(`${green('✓')} removed project ${project.name}`);
    return 0;
  }
  const ref = p.positional[0];
  if (!ref && !flagStr(p, 'id')) throw new CliError('usage: salu remove "name"');
  const t = resolveTicket(db, ref ?? '', { project: flagStr(p, 'project'), id: flagStr(p, 'id') });
  const running = t.status === 'running';
  if (!(await confirm(p, `Delete ticket "${t.name}"${running ? ' (it is running and will be stopped)' : ''}?`))) return 1;
  deleteTicket(db, t.id);
  console.log(`${green('✓')} removed #${t.id} ${t.name} ${dim(`from ${t.project}`)}`);
  return 0;
}
