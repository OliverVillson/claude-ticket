import type { Database } from 'bun:sqlite';
import type { OrchestratorEvent } from '../orchestrator/types.ts';
import { getProjectById, getTicketById, listTurns } from '../db/queries.ts';
import { boxName } from './sync.ts';
import { REPLY_MAX, newId } from './format.ts';
import { addRemoteTicket, enqueueMessage, type NewMessage, getRemote, remoteTicketForLocal } from './store.ts';

const clip = (s: string | null | undefined, n: number) => (s && s.length > n ? s.slice(0, n - 1) + '…' : (s ?? ''));

/**
 * Turn what the orchestrator does into messages for `salu notif`, for projects that are a box
 * (`salu remote add <project> <url> --box`). Only writes to the local database; the sync loop sends them.
 */
export function recordRemoteEvent(db: Database, e: OrchestratorEvent): void {
  try {
    // The runner's `environment` event (the orchestrator stopped: dead login, missing tool). Matched by name so
    // this works before that event exists in OrchestratorEvent.
    const ev = e as { type: string; message?: unknown };
    if (ev.type === 'environment') {
      const reason = typeof ev.message === 'string' && ev.message.trim() ? ev.message.trim() : 'the environment is broken';
      for (const r of db.query<{ project_id: number }, []>("SELECT project_id FROM remotes WHERE role = 'box'").all()) {
        const project = getProjectById(db, r.project_id);
        if (project) enqueueMessage(db, project.id, project.name, boxName(), { type: 'note', level: 'error', title: `The box stopped: ${clip(reason, 300)}`, body: `${clip(reason, 2000)}\nFix it on the box (for a dead login: run claude and /login), then run: salu runner restart ${project.name}`.trim() });
      }
      return;
    }
    if (e.type === 'dispatch' || e.type === 'finish') {
      const t = e.ticket;
      const remote = getRemote(db, t.project_id);
      if (!remote || remote.role !== 'box') return;
      const project = getProjectById(db, t.project_id);
      if (!project) return;
      const ref = remoteTicketForLocal(db, t.id, 'in')?.uuid;
      // The worker's whole final reply, so whoever reads the notification sees what they are answering.
      const last = e.type === 'finish' ? [...listTurns(db, t.id)].reverse().find((x) => x.role === 'assistant')?.body : undefined;
      const reply = last ? clip(last, REPLY_MAX) : undefined;
      const ticket = { ...(ref ? { ref } : {}), name: t.name, id: t.id };
      const send = (m: Parameters<typeof enqueueMessage>[4]) => enqueueMessage(db, project.id, project.name, boxName(), m);
      if (e.type === 'dispatch') {
        if (!e.resumed) send({ type: 'ticket.started', level: 'info', title: `Started "${t.name}"`, ticket });
        return;
      }
      if (e.status === 'done') send({ type: 'ticket.done', level: 'success', title: `Done: "${t.name}"`, body: clip(t.error, 2000) || undefined, reply, ticket });
      else if (e.status === 'blocked') send({ type: 'ticket.blocked', level: 'warn', title: `"${t.name}" needs you`, question: clip(e.error ?? t.error, 2000) || undefined, reply, ticket });
      else if (e.status === 'failed') send({ type: 'ticket.failed', level: 'error', title: `Failed: "${t.name}"`, body: clip(e.error ?? t.error, 2000) || undefined, reply, ticket });
      return;
    }
    if (e.type === 'pause' || e.type === 'resume') {
      // Orchestrator-wide: tell every project that has this machine as its box.
      for (const r of db.query<{ project_id: number }, []>("SELECT project_id FROM remotes WHERE role = 'box'").all()) {
        const project = getProjectById(db, r.project_id);
        if (!project) continue;
        if (e.type === 'pause') enqueueMessage(db, project.id, project.name, boxName(), { type: 'orchestrator.paused', level: 'warn', title: `Paused: ${clip(e.reason, 200)}`, ...(e.until ? { until: e.until } : {}) });
        else enqueueMessage(db, project.id, project.name, boxName(), { type: 'orchestrator.resumed', level: 'info', title: 'Running again' });
      }
    }
  } catch {
    /* messages are best effort: never stop the loop */
  }
}

/**
 * For anything on the box that knows something about one ticket (the worker's status checklist, a decision it
 * wants answered, outputs it made, a state change): queue a message for the clients of that ticket's project.
 * `ticket` and the sender are filled in. A no-op unless the ticket's project is a box.
 */
export function postThreadMessage(db: Database, ticketId: number, m: Omit<NewMessage, 'ticket'>): boolean {
  const t = getTicketById(db, ticketId);
  if (!t) return false;
  const remote = getRemote(db, t.project_id);
  const project = getProjectById(db, t.project_id);
  if (!remote || remote.role !== 'box' || !project) return false;
  announceSpawned(db, t.id); // a new sub-thread must be known to clients before they hear about its progress
  const ref = remoteTicketForLocal(db, t.id, 'in')?.uuid;
  enqueueMessage(db, project.id, project.name, boxName(), { ...m, ticket: { ...(ref ? { ref } : {}), name: t.name, id: t.id } });
  return true;
}

/**
 * Box: a sub-thread a worker started gets a reference of its own (so messages about it can be matched by
 * clients) and one `ticket.spawned` message naming its parent. Does nothing for a ticket that has no parent,
 * is already announced, or whose project is not a box.
 */
export function announceSpawned(db: Database, ticketId: number): void {
  const t = getTicketById(db, ticketId);
  if (!t || remoteTicketForLocal(db, t.id, 'in')) return;
  const remote = getRemote(db, t.project_id);
  const project = getProjectById(db, t.project_id);
  const parent = db.query<{ id: number; name: string }, [number]>('SELECT p.id, p.name FROM tickets t JOIN tickets p ON p.id = t.parent_id WHERE t.id = ?').get(t.id);
  if (!remote || remote.role !== 'box' || !project || !parent) return;
  const ref = newId();
  addRemoteTicket(db, { uuid: ref, project_id: project.id, ticket_id: t.id, direction: 'in', queue: true, sent: true });
  const parentRef = remoteTicketForLocal(db, parent.id, 'in')?.uuid;
  enqueueMessage(db, project.id, project.name, boxName(), {
    type: 'ticket.spawned',
    level: 'info',
    title: `"${parent.name}" started "${t.name}"`,
    body: t.query.slice(0, 2000),
    state: t.status,
    ticket: { ref, name: t.name, id: t.id },
    parent: { ...(parentRef ? { ref: parentRef } : {}), name: parent.name, id: parent.id },
  });
}

/** Box: announce every sub-thread of a project that has not been yet (a sync sweep; posting does it too). */
export function announceAllSpawned(db: Database, projectId: number): void {
  const rows = db.query<{ id: number }, [number]>("SELECT id FROM tickets WHERE project_id = ? AND parent_id IS NOT NULL AND id NOT IN (SELECT ticket_id FROM remote_tickets WHERE ticket_id IS NOT NULL AND direction = 'in') ORDER BY id").all(projectId);
  for (const r of rows) announceSpawned(db, r.id);
}
