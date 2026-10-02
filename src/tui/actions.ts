import type { Database } from 'bun:sqlite';
import type { Project, TicketView } from '../db/types.ts';
import { createTicket, deleteTicket, getProjectById, getProjectByName, markFollowUpsDelivered, queueTicket, replyToTicket, resolveTicketById, unqueueTicket, updateTicket, wakeOrchestrator } from '../db/queries.ts';
import { fetchInBackground } from '../notif/index.ts';
import { getRemote } from '../sync/store.ts';
import { publishAction, publishReply, publishTicket } from '../sync/sync.ts';
import { clearPause, enterManualPause } from '../usage/index.ts';
import { parseTags, validatePriority } from '../core/tags.ts';
import { CliError } from '../core/errors.ts';
import { answerAndNotify, answerOpenWithText } from '../threads/decide.ts';
import { allowTicket } from '../core/allow.ts';

/** What the add/edit form collects. `tags` is the same string `salu add` takes. */
export interface TicketInput {
  projectId: number;
  name: string;
  query: string;
  tags: string;
  /** "1".."5", "now" (= 0) or empty (keep the ticket's priority, else `priority=` in tags, else 3) */
  priority?: string;
  /** save and queue in one go (a new ticket is otherwise only saved to the backlog) */
  queue?: boolean;
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
  /** Queue a saved or finished ticket, or take a queued one back to the backlog. Returns what happened. */
  toggleQueue(ticket: TicketView): 'queued' | 'unqueued';
  /** Allow what a blocked ticket was refused and queue it again. Returns the rules added. */
  allow(ticket: TicketView): string[];
  /** Mark a ticket resolved: you are finished with it (a reply brings it back). */
  resolve(ticket: TicketView): TicketView;
  /** Send a follow-up on a ticket that has a reply (or answer a blocked one); it goes back in the queue. */
  reply(ticket: TicketView, message: string): TicketView;
  /** Pick option `index` (0-based) of an open decision; any pick but the recommended one tells the worker. */
  answerDecision(ticket: TicketView, decisionId: number, index: number): TicketView | null;
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
      const projectId = resolveProjectId(db, input, v.project);
      const project = getProjectById(db, projectId);
      const toBox = !!project && getRemote(db, projectId)?.role === 'client';
      // A ticket for a box is created unclaimable (backlog) and sent there; it only shows as queued once published.
      const t = createTicket(db, {
        project_id: projectId,
        name: v.name,
        query: v.query,
        tags: v.tags,
        labels: v.labels,
        priority: v.priority,
        status: input.queue && !toBox ? 'todo' : 'backlog',
      });
      if (toBox) {
        publishTicket(db, project!, t, { queue: !!input.queue });
        void fetchInBackground(db, { now: true });
        return input.queue ? updateTicket(db, t.id, { status: 'todo' }) : t;
      }
      if (input.queue) wakeOrchestrator();
      return t;
    },
    update(ticket, input) {
      const v = validateInput(input, ticket);
      const saved = updateTicket(db, ticket.id, {
        project_id: resolveProjectId(db, input, v.project),
        name: v.name,
        query: v.query,
        tags: JSON.stringify(v.tags),
        labels: JSON.stringify(v.labels),
        priority: v.priority,
      });
      return input.queue && saved.status === 'backlog' ? queueTicket(db, saved.id) : saved;
    },
    toggleQueue(ticket) {
      if (ticket.status === 'todo') {
        unqueueTicket(db, ticket.id);
        return 'unqueued';
      }
      queueTicket(db, ticket.id);
      return 'queued';
    },
    allow(ticket) {
      const r = allowTicket(db, ticket.id);
      wakeOrchestrator();
      return r.rules;
    },
    remove(ticket) {
      deleteTicket(db, ticket.id);
    },
    runNow(ticket) {
      if (ticket.status === 'running') return;
      queueTicket(db, ticket.id, { now: true });
    },
    resolve(ticket) {
      const t = resolveTicketById(db, ticket.id);
      const project = getProjectById(db, t.project_id);
      if (project && publishAction(db, project, t, 'resolve')) void fetchInBackground(db, { now: true });
      return t;
    },
    reply(ticket, message) {
      const t = replyToTicket(db, ticket.id, message);
      answerOpenWithText(db, ticket.id, message); // typed words answer open decisions, like `salu reply`
      const project = getProjectById(db, t.project_id);
      if (project && publishReply(db, project, t, message)) {
        markFollowUpsDelivered(db, t.id); // it runs on the box: nothing waits for a local worker
        void fetchInBackground(db, { now: true });
      }
      return t;
    },
    answerDecision(ticket, decisionId, index) {
      return answerAndNotify(db, ticket.id, decisionId, index).ticket;
    },
    togglePause(currentlyPaused) {
      if (currentlyPaused) clearPause(db);
      else enterManualPause(db);
      wakeOrchestrator();
    },
  };
}
