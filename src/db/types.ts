/** backlog = saved, never runs by itself; todo = queued (eligible to run); the rest are as named. */
export type TicketStatus = 'backlog' | 'todo' | 'running' | 'done' | 'failed' | 'blocked' | 'paused';
export const TICKET_STATUSES: TicketStatus[] = ['backlog', 'todo', 'running', 'done', 'failed', 'blocked', 'paused'];

export type RunOutcome = 'done' | 'failed' | 'blocked' | 'rate_limited' | 'killed';

export interface Project {
  id: number;
  name: string;
  path: string;
  is_default: number; // 0 | 1
  default_model: string | null;
  default_effort: string | null;
  default_tools: string | null;
  sandbox: number; // 0 | 1: workers run in the kernel sandbox
  concurrency: number | null;
  created_at: number; // epoch ms
  parent_id: number | null; // null = top-level project
}

/** A project in the tree, with ticket counts for the project alone (`own`) and its whole subtree (`counts`). */
export interface ProjectNode extends Project {
  depth: number;
  children: ProjectNode[];
  counts: Record<TicketStatus, number>;
  own: Record<TicketStatus, number>;
}

export interface Ticket {
  id: number;
  project_id: number;
  name: string;
  query: string;
  tags: string; // JSON object: { model?, effort?, "max-turns"?, permission?, ...custom }
  labels: string; // JSON array of bare labels
  priority: number; // 1 (highest) .. 5
  status: TicketStatus;
  attempts: number;
  session_id: string | null;
  cost_usd: number;
  error: string | null;
  denied?: string | null; // JSON array of { tool, input, rule }: tool uses the last run was refused
  summary?: string | null; // the worker's short final report (set when the ticket is done)
  branch?: string | null; // the salu/<ticket> git branch the work was committed on, when there is one
  depends_on: string | null; // reserved
  parent_id?: number | null; // the ticket whose worker started this one as a sub-thread
  seat_id?: number | null; // the Claude seat the ticket ran on (null = this machine's own login)
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
}

export interface Run {
  id: number;
  ticket_id: number;
  started_at: number;
  ended_at: number | null;
  outcome: RunOutcome | null;
  turns: number | null;
  cost_usd: number | null;
  log_path: string | null;
}

/**
 * One message on a ticket after the first prompt. `user` turns are follow-ups (delivered = 0 until a
 * worker has been given them), `assistant` turns are the worker's final reply of a run.
 */
export interface Turn {
  id: number;
  ticket_id: number;
  role: 'user' | 'assistant';
  body: string;
  delivered: number; // 0 | 1
  created_at: number;
}

/** A ticket joined with its project name, as most views want it. */
export interface TicketView extends Ticket {
  project: string;
  project_path: string;
}

export function ticketTags(t: Pick<Ticket, 'tags'>): Record<string, string> {
  try {
    const v = JSON.parse(t.tags || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

export function ticketLabels(t: Pick<Ticket, 'labels'>): string[] {
  try {
    const v = JSON.parse(t.labels || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Orchestrator state keys stored in the `state` table. */
export const STATE = {
  pid: 'orchestrator_pid',
  heartbeat: 'orchestrator_heartbeat', // epoch ms
  startedAt: 'orchestrator_started_at',
  pausedUntil: 'paused_until', // epoch ms
  pauseReason: 'pause_reason', // human text
  pauseKind: 'pause_kind', // 'session' | 'weekly' | 'opus' | 'manual' | 'unknown'
  pauseModels: 'pause_models', // '' (all) or comma list of model prefixes, e.g. 'opus'
  manualPause: 'manual_pause', // '1' when `salu pause` was used
  concurrency: 'concurrency', // global cap override
} as const;
