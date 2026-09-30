import type { Database } from 'bun:sqlite';
import type { Project, TicketView } from '../db/types.ts';
import { createTicket, deleteTicket, getProjectByName, updateTicket, wakeOrchestrator } from '../db/queries.ts';
import { clearPause, enterManualPause } from '../usage/index.ts';
import { parseTags, validatePriority } from '../core/tags.ts';
import { CliError } from '../core/errors.ts';

/** What the add/edit form collects. `tags` is the same string `salu add` takes. */
export interface TicketInput {
  projectId: number;
  name: string;
  query: string;
  tags: string;
  /** "1".."5", "now" (= 0) or empty (keep the ticket's priority, else `priority=` in tags, else 3) */
  priority?: string;
}

/** The "run now" priority: sorts ahead of 1..5, set by the `r` key, rendered as `now`. */
export const PRIORITY_NOW = 0;

/**
 * Everything the list view can do to the world. The defaults act on the database and the
 * orchestrator's state table; `openList({ actions })` can override any of them.
 */
export interface TuiActions {
  create(input: TicketInput): TicketView;
  update(ticket: TicketView, input: TicketInput): TicketView;
  remove(ticket: TicketView): void;
  /** Move a ticket to the front of the queue (priority 0); re-queues finished ones. */
  runNow(ticket: TicketView): void;
  /** Pause dispatch, or resume it when `currentlyPaused`. */
  togglePause(currentlyPaused: boolean): void;
}

export function parsePriorityField(v: string | undefined, fallback: number): number {
  const s = (v ?? '').trim().toLowerCase();
  if (!s) return fallback;
  if (s === 'now' || s === '0') return PRIORITY_NOW;
  return validatePriority(s);
}

export function validateInput(
  input: TicketInput,
  existing?: TicketView,
): { name: string; query: string; tags: Record<string, string>; labels: string[]; priority: number; project?: string } {
  const name = input.name.trim();
  if (!name) throw new CliError('name is required');
  const query = input.query.trim();
  if (!query) throw new CliError('query is required');
  const parsed = parseTags(input.tags);
  const priority = parsePriorityField(input.priority, parsed.priority ?? existing?.priority ?? 3);
  return { name, query, tags: parsed.tags, labels: parsed.labels, priority, project: parsed.project };
}

function resolveProjectId(db: Database, input: TicketInput, project?: string): number {
  if (!project) return input.projectId;
  const p: Project | null = getProjectByName(db, project);
  if (!p) throw new CliError(`no project named "${project}"`);
  return p.id;
}

export function defaultActions(db: Database): TuiActions {
  return {
    create(input) {
      const v = validateInput(input);
      return createTicket(db, {
        project_id: resolveProjectId(db, input, v.project),
        name: v.name,
        query: v.query,
        tags: v.tags,
        labels: v.labels,
        priority: v.priority,
      });
    },
    update(ticket, input) {
      const v = validateInput(input, ticket);
      return updateTicket(db, ticket.id, {
        project_id: resolveProjectId(db, input, v.project),
        name: v.name,
        query: v.query,
        tags: JSON.stringify(v.tags),
        labels: JSON.stringify(v.labels),
        priority: v.priority,
      });
    },
    remove(ticket) {
      deleteTicket(db, ticket.id);
    },
    runNow(ticket) {
      if (ticket.status === 'running') return;
      updateTicket(db, ticket.id, { status: 'todo', priority: PRIORITY_NOW, attempts: 0, error: null, finished_at: null });
    },
    togglePause(currentlyPaused) {
      if (currentlyPaused) clearPause(db);
      else enterManualPause(db);
      wakeOrchestrator();
    },
  };
}
