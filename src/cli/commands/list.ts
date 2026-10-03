import type { Parsed } from '../args.ts';
import { flagBool, flagStr } from '../args.ts';
import { ticketDenials } from '../../core/allow.ts';
import { openDb } from '../../db/db.ts';
import { countTickets, flattenProjectTree, listProjectTree, listProjects, listTickets } from '../../db/queries.ts';
import { TICKET_STATUSES, ticketLabels, ticketTags, type TicketStatus } from '../../db/types.ts';
import { formatTags } from '../../core/tags.ts';
import { resolveProject } from '../../core/resolve.ts';
import { CliError } from '../../core/errors.ts';
import { dim, safeText, yellow } from '../../core/ansi.ts';
import { formatAgo, formatCost, parseStatus, statusColor, statusIcon, statusLabel, table } from '../../core/format.ts';
import { loadTeam, ticketWho, type TeamView } from '../../team/view.ts';
import { helpIf, isTTY } from './_shared.ts';

const HELP = `salu list [project] [--plain] [--status S[,S]] [--all] [--projects] [--json]

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
      console.log(dim('no projects yet: salu add project "name" [path]'));
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
        flattenProjectTree(listProjectTree(db)).map((pr) => {
          const c = pr.counts; // the project's own tickets plus every subproject's
          const defaults = [pr.default_model && `model=${pr.default_model}`, pr.default_effort && `effort=${pr.default_effort}`, pr.default_tools && `tools=${pr.default_tools}`, pr.sandbox && 'sandbox', pr.concurrency && `concurrency=${pr.concurrency}`]
            .filter(Boolean)
            .join(' ');
          const indent = pr.depth ? `${'  '.repeat(pr.depth - 1)}└ ` : '';
          return {
            name: indent + (pr.is_default ? `${pr.name} ${dim('(default)')}` : pr.name),
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
    ? statusFlag.split(',').map((raw) => {
        const s = parseStatus(raw);
        if (!TICKET_STATUSES.includes(s as TicketStatus)) throw new CliError(`status must be one of ${TICKET_STATUSES.map(statusLabel).join(', ')}`);
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
  const teams = new Map<number, TeamView>();
  const teamOf = (id: number) => teams.get(id) ?? (teams.set(id, loadTeam(db, id)), teams.get(id)!);
  const whoOf = (t: (typeof tickets)[number]) => ticketWho(t, teamOf(t.project_id));
  const showTeam = tickets.some((t) => teamOf(t.project_id).active);
  if (json) {
    console.log(
      JSON.stringify(
        tickets.map((t) => ({ ...t, tags: ticketTags(t), labels: ticketLabels(t), denied: ticketDenials(t), ...(teamOf(t.project_id).active ? { who: whoOf(t) } : {}) })),
        null,
        2,
      ),
    );
    return 0;
  }
  if (!tickets.length) {
    console.log(dim(project ? `no tickets in ${project.name}` : 'no tickets yet: salu add "name" "query" ["tags"]'));
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
        ...(showTeam ? [{ key: 'by', title: 'by' }, { key: 'seat', title: 'seat' }] : []),
        { key: 'when', title: 'updated' },
        { key: 'cost', title: 'cost', align: 'right' },
      ],
      tickets.map((t) => ({
        id: String(t.id),
        status: statusColor(t.status)(`${statusIcon(t.status)} ${statusLabel(t.status)}`),
        pri: t.priority === 0 ? 'now' : String(t.priority),
        name: safeText(t.name),
        project: t.project,
        tags: dim(formatTags(ticketTags(t), ticketLabels(t))),
        by: (showTeam && whoOf(t).author) || dim('-'),
        seat: showTeam ? seatCell(whoOf(t)) : '',
        when: dim(formatAgo(t.updated_at, now)),
        cost: t.cost_usd ? formatCost(t.cost_usd) : '',
      })),
    ),
  );
  for (const t of tickets) {
    const rules = t.status === 'blocked' ? [...new Set(ticketDenials(t).map((d) => d.rule))] : [];
    if (rules.length) console.log(`${yellow('!')} ${safeText(t.name)} is blocked: needs permission ${rules.join(', ')}  ${dim(`→ salu allow "${safeText(t.name)}"`)}`);
  }
  return 0;
}

/** `alice 62% left` for a ticket run on a seat, `-` while it has none. A borrowed seat names its owner. */
function seatCell(w: ReturnType<typeof ticketWho>): string {
  if (!w.seat) return dim('-');
  const left = w.meter && w.meter.percentUsed != null ? ` ${100 - w.meter.percentUsed}% left` : '';
  return `${w.seat}${w.seatOwner ? dim(` (${w.seatOwner}'s)`) : ''}${dim(left)}`;
}
