import type { Database } from 'bun:sqlite';
import type { Project, Run, TicketStatus, TicketView, Turn } from '../db/types.ts';
import { countTickets, latestRun, listProjects, listTickets, listTurns } from '../db/queries.ts';
import { readStatus, type OrchestratorStatus } from '../orchestrator/status.ts';

export interface Scope {
  /** null or undefined = every project */
  projectId?: number | null;
  /** only these statuses (from `salu list --status`) */
  statuses?: TicketStatus[];
}

export interface Snapshot {
  tickets: TicketView[];
  projects: Project[];
  counts: Record<TicketStatus, number>;
  status: OrchestratorStatus;
  loadedAt: number;
}

/** One consistent read of everything the list view shows. Cheap: four small queries. */
export function loadSnapshot(db: Database, scope: Scope = {}): Snapshot {
  const now = Date.now();
  const projectId = scope.projectId ?? undefined;
  return {
    tickets: listTickets(db, { projectId, status: scope.statuses?.length ? scope.statuses : undefined }),
    projects: listProjects(db),
    counts: countTickets(db, projectId),
    status: readStatus(db, now),
    loadedAt: now,
  };
}

/**
 * A cheap fingerprint so polling only re-renders when something changed: ticket rows
 * (id, status, priority, updated_at, cost), the project list and the orchestrator state.
 */
export function snapshotKey(s: Snapshot): string {
  let out = '';
  for (const t of s.tickets) out += `${t.id}:${t.status}:${t.priority}:${t.updated_at}:${t.cost_usd};`;
  out += '|';
  for (const p of s.projects) out += `${p.id}:${p.name}:${p.is_default}:${(p as { parent_id?: number | null }).parent_id ?? ""};`;
  const o = s.status;
  const p = o.paused;
  out += `|${o.alive ? 1 : 0}:${o.pid}:${p ? `${p.until}:${p.kind}:${p.manual ? 1 : 0}:${p.reason}:${p.models.join(',')}` : ''}`;
  for (const w of o.workers) out += `;${w.ticketId}:${w.turns}:${w.lastTool}`;
  return out;
}

export interface TicketDetail {
  ticket: TicketView;
  run: Run | null;
  /** follow-ups and replies after the first prompt */
  turns: Turn[];
}

export function loadDetail(db: Database, ticket: TicketView): TicketDetail {
  return { ticket, run: latestRun(db, ticket.id), turns: listTurns(db, ticket.id) };
}
