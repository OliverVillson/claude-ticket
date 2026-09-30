import type { Parsed } from '../args.ts';
import { flagBool, flagStr } from '../args.ts';
import { openDb } from '../../db/db.ts';
import { countTickets, listProjects, listTickets } from '../../db/queries.ts';
import { TICKET_STATUSES, ticketLabels, ticketTags, type TicketStatus } from '../../db/types.ts';
import { formatTags } from '../../core/tags.ts';
import { resolveProject } from '../../core/resolve.ts';
import { CliError } from '../../core/errors.ts';
import { dim } from '../../core/ansi.ts';
import { formatAgo, formatCost, statusColor, statusIcon, table } from '../../core/format.ts';
import { helpIf, isTTY } from './_shared.ts';

const HELP = `ticket list [project] [--plain] [--status S[,S]] [--all] [--projects] [--json]

Opens the interactive list (arrow keys move, Enter opens a ticket, a/e/d/r add, edit,
delete, run; p pauses; / filters; Tab switches project; q quits). --plain prints a table
and exits; that is also what you get when stdout is not a terminal. With no project the
list shows every project.`;

export async function list(p: Parsed): Promise<number> {
  if (helpIf(p, HELP)) return 0;
  const db = openDb();
  const json = flagBool(p, 'json');

  if (flagBool(p, 'projects')) {
    const projects = listProjects(db);
    if (json) {
      console.log(JSON.stringify(projects, null, 2));
      return 0;
    }
    if (!projects.length) {
      console.log(dim('no projects yet: ticket add project "name" [path]'));
      return 0;
    }
    console.log(
      table(
        [
          { key: 'name', title: 'project' },
          { key: 'path', title: 'path' },
          { key: 'tickets', title: 'tickets', align: 'right' },
          { key: 'defaults', title: 'defaults' },
        ],
        projects.map((pr) => {
          const c = countTickets(db, pr.id);
          const defaults = [pr.default_model && `model=${pr.default_model}`, pr.default_effort && `effort=${pr.default_effort}`, pr.concurrency && `concurrency=${pr.concurrency}`]
            .filter(Boolean)
            .join(' ');
          return {
            name: pr.is_default ? `${pr.name} ${dim('(default)')}` : pr.name,
            path: pr.path,
            tickets: `${c.todo + c.running + c.paused + c.blocked}/${Object.values(c).reduce((a, b) => a + b, 0)}`,
            defaults,
          };
        }),
      ),
    );
    return 0;
  }

  const projectName = p.positional[0] ?? flagStr(p, 'project');
  const project = projectName ? resolveProject(db, projectName) : null;
  const statusFlag = flagStr(p, 'status');
  const statuses = statusFlag
    ? statusFlag.split(',').map((s) => {
        if (!TICKET_STATUSES.includes(s as TicketStatus)) throw new CliError(`status must be one of ${TICKET_STATUSES.join(', ')}`);
        return s as TicketStatus;
      })
    : undefined;

  const plain = flagBool(p, 'plain') || json || !isTTY();
  if (!plain) {
    const { openList } = await import('../../tui/index.tsx');
    await openList({ projectId: project?.id, statuses });
    return 0;
  }

  const tickets = listTickets(db, { projectId: project?.id, status: statuses });
  if (json) {
    console.log(
      JSON.stringify(
        tickets.map((t) => ({ ...t, tags: ticketTags(t), labels: ticketLabels(t) })),
        null,
        2,
      ),
    );
    return 0;
  }
  if (!tickets.length) {
    console.log(dim(project ? `no tickets in ${project.name}` : 'no tickets yet: ticket add "name" "query" ["tags"]'));
    return 0;
  }
  const now = Date.now();
  const multi = !project && new Set(tickets.map((t) => t.project_id)).size > 1;
  console.log(
    table(
      [
        { key: 'id', title: '#', align: 'right' },
        { key: 'status', title: 'status' },
        { key: 'pri', title: 'pri', align: 'right' },
        { key: 'name', title: 'name', max: 32 },
        ...(multi ? [{ key: 'project', title: 'project' }] : []),
        { key: 'tags', title: 'tags', max: 40 },
        { key: 'when', title: 'updated' },
        { key: 'cost', title: 'cost', align: 'right' },
      ],
      tickets.map((t) => ({
        id: String(t.id),
        status: statusColor(t.status)(`${statusIcon(t.status)} ${t.status}`),
        pri: t.priority === 0 ? 'now' : String(t.priority),
        name: t.name,
        project: t.project,
        tags: dim(formatTags(ticketTags(t), ticketLabels(t))),
        when: dim(formatAgo(t.updated_at, now)),
        cost: t.cost_usd ? formatCost(t.cost_usd) : '',
      })),
    ),
  );
  return 0;
}
