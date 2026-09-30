import type { Database } from 'bun:sqlite';
import type { OrchestratorEvent } from '../orchestrator/types.ts';
import { getProjectById, listTurns } from '../db/queries.ts';
import { boxName } from './sync.ts';
import { REPLY_MAX } from './format.ts';
import { enqueueMessage, getRemote, remoteTicketForLocal } from './store.ts';

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
