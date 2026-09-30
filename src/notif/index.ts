// `salu notif`: what the project orchestrators have to tell you.
//
// Messages are the ones the git transport defines (src/sync/format.ts, INTERFACES.md "Git sync
// transport"): the orchestrator on a box writes them, the sync carries them over `salu/inbox`, and
// this machine keeps them in `remote_messages` until you read them. This module is the reading side:
// list them newest first, mark them read, and fetch new ones in the background.
//
// An orchestrator running on this machine (no box involved) posts through `notifyEvent`; those
// messages are stored as if they had arrived, so one window shows both. For a project that is a
// box, the transport's own `recordRemoteEvent` already queues the message for the client, so
// `notifyEvent` leaves those alone.
import type { Database } from 'bun:sqlite';
import { spawn, type ChildProcess } from 'node:child_process';
import { getProjectById } from '../db/queries.ts';
import type { OrchestratorEvent } from '../orchestrator/types.ts';
import { newId, type MessageFile } from '../sync/format.ts';
import { enqueueMessage, getRemote, listNotifications, listRemotes, markRead as storeMarkRead, storeIncomingMessage, unreadCount, type NewMessage, type Notification } from '../sync/store.ts';
import { boxName } from '../sync/sync.ts';

export type Notif = Notification;
export type { NewMessage };

export const countUnread = unreadCount;

export interface ListOptions {
  /** only unread ones (default: all) */
  unread?: boolean;
  projectId?: number;
  limit?: number;
}

/** Newest first. */
export function listNotifs(db: Database, o: ListOptions = {}): Notif[] {
  return listNotifications(db, { all: !o.unread, projectId: o.projectId, limit: o.limit }).reverse();
}

export function getNotif(db: Database, id: string): Notif | null {
  return listNotifications(db, { all: true, limit: 100000 }).find((n) => n.id === id) ?? null;
}

/** Mark these read; returns how many were unread before. */
export function markRead(db: Database, ids: string[]): number {
  return storeMarkRead(db, ids);
}

export function markAllRead(db: Database, projectId?: number): number {
  if (projectId === undefined) return storeMarkRead(db, 'all');
  return storeMarkRead(db, listNotifs(db, { unread: true, projectId, limit: 100000 }).map((n) => n.id));
}

/** The short name a message goes by on the command line: the random part of its id. */
export function shortId(n: { id: string }): string {
  return n.id.slice(n.id.indexOf('-') + 1);
}

/** Resolve what a user typed (`#ab12cd34`, the short name, or the full id) to one message id, or null. */
export function resolveNotifId(db: Database, arg: string): string | null {
  const a = arg.replace(/^#/, '').toLowerCase();
  if (!a) return null;
  const all = listNotifications(db, { all: true, limit: 100000 });
  const hits = all.filter((n) => n.id === a || shortId(n).startsWith(a));
  return hits.length === 1 ? hits[0]!.id : null;
}

// --- how a message reads ---------------------------------------------------------------------

/** The message's text for a detail view: the question or body, then where the result is and when it resumes. */
export function notifText(n: Notif, now = Date.now()): string[] {
  const out: string[] = [];
  const text = n.question || n.body;
  if (text) out.push(text);
  if (n.branch) out.push(`result: branch ${n.branch}`);
  if (n.until) out.push(n.until > now ? `resumes at ${new Date(n.until).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : 'resume time has passed');
  return out;
}

// --- a local orchestrator posts ---------------------------------------------------------------

/** Store a message on this machine as if it had arrived from a box; false when it was already there. */
export function postLocal(db: Database, projectId: number, m: NewMessage): boolean {
  const project = getProjectById(db, projectId);
  if (!project) return false;
  const id = newId(m.at);
  const msg: MessageFile = { ...m, v: 1, id, project: project.name, from: 'this computer', at: Number(id.slice(0, 13)) };
  return storeIncomingMessage(db, projectId, msg);
}

const clip = (s: string | null | undefined, n: number) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || undefined);

/**
 * What a local orchestrator tells you. Only the things that need a human: a ticket done, blocked,
 * failed for good, or the orchestrator paused by the usage limit. Retries and your own manual
 * pause stay silent. Never throws.
 */
export function notifyEvent(db: Database, e: OrchestratorEvent): void {
  try {
    if (e.type === 'finish') {
      const t = e.ticket;
      if (getRemote(db, t.project_id)?.role === 'box') return; // the transport queues these for the client
      const ticket = { name: t.name, id: t.id };
      if (e.status === 'done') postLocal(db, t.project_id, { type: 'ticket.done', level: 'success', title: `Done: "${t.name}"`, ticket });
      else if (e.status === 'blocked') postLocal(db, t.project_id, { type: 'ticket.blocked', level: 'warn', title: `"${t.name}" needs you`, question: clip(e.error ?? t.error, 2000), ticket });
      else if (e.status === 'failed') postLocal(db, t.project_id, { type: 'ticket.failed', level: 'error', title: `Failed: "${t.name}"`, body: clip(e.error ?? t.error, 2000), ticket });
      else if (e.status === 'paused') postLocal(db, t.project_id, { type: 'orchestrator.paused', level: 'warn', title: `"${t.name}" paused: usage limit reached`, body: 'It continues by itself when the limit resets.', ticket });
    }
  } catch {
    /* a message that cannot be stored must not stop the orchestrator */
  }
}

/**
 * A problem that stops the orchestrator (an expired login, a missing Claude Code): the one time an
 * unattended machine has to reach you. On a box the message is queued for the client; elsewhere it
 * is stored here. Never throws.
 */
export function notifyProblem(db: Database, projectId: number, title: string, body: string): void {
  try {
    const project = getProjectById(db, projectId);
    if (!project) return;
    const m: NewMessage = { type: 'note', level: 'error', title: clip(title, 300)!, body: clip(body, 2000) };
    if (getRemote(db, projectId)?.role === 'box') enqueueMessage(db, projectId, project.name, boxName(), m);
    else postLocal(db, projectId, m);
  } catch {
    /* best effort */
  }
}

// --- fetching ---------------------------------------------------------------------------------

/** True when some project sends its tickets to a box, so there may be messages to fetch. */
export function hasClientRemote(db: Database): boolean {
  return listRemotes(db).some((r) => r.role === 'client');
}

let fetching: ChildProcess | null = null;

/**
 * Ask the git transport for new messages without waiting for it: runs `salu remote sync` in the
 * background (the window's own poll picks up what it stores). At most one at a time; returns false
 * when there is nothing to fetch from or one is already running.
 */
export async function fetchInBackground(db: Database): Promise<boolean> {
  if (fetching || !hasClientRemote(db) || process.env.SALU_NO_FETCH) return false;
  const { selfCommand } = await import('../orchestrator/index.ts');
  const [cmd, ...rest] = selfCommand(['remote', 'sync']);
  const child = spawn(cmd!, rest, { stdio: 'ignore', env: process.env });
  fetching = child;
  const done = () => {
    if (fetching === child) fetching = null;
  };
  child.on('exit', done);
  child.on('error', done);
  child.unref();
  return true;
}
