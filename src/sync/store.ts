import type { Database } from 'bun:sqlite';
import type { ActionFile, MessageFile, ReplyFile } from './format.ts';
import { newId } from './format.ts';

export type RemoteRole = 'client' | 'box';

export interface Remote {
  project_id: number;
  url: string;
  role: RemoteRole;
  name: string;
  last_sync: number | null;
  last_error: string | null;
}

export function getRemote(db: Database, projectId: number): Remote | null {
  return db.query<Remote, [number]>('SELECT * FROM remotes WHERE project_id = ?').get(projectId) ?? null;
}

export function listRemotes(db: Database): Remote[] {
  return db.query<Remote, []>('SELECT * FROM remotes ORDER BY project_id').all();
}

export function setRemote(db: Database, r: { project_id: number; url: string; role: RemoteRole; name: string }): void {
  db.run(
    `INSERT INTO remotes (project_id, url, role, name) VALUES (?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET url = excluded.url, role = excluded.role, name = excluded.name`,
    [r.project_id, r.url, r.role, r.name],
  );
}

export function removeRemote(db: Database, projectId: number): void {
  db.run('DELETE FROM remotes WHERE project_id = ?', [projectId]);
}

export function markSynced(db: Database, projectId: number, error: string | null): void {
  if (error) db.run('UPDATE remotes SET last_error = ? WHERE project_id = ?', [error, projectId]);
  else db.run('UPDATE remotes SET last_sync = ?, last_error = NULL WHERE project_id = ?', [Date.now(), projectId]);
}

// --- tickets -----------------------------------------------------------------------------

export interface RemoteTicket {
  uuid: string;
  project_id: number;
  ticket_id: number | null;
  direction: 'out' | 'in';
  sent: number; // out: 1 once it is on the remote
  queue: number;
}

export function addRemoteTicket(db: Database, t: { uuid: string; project_id: number; ticket_id: number | null; direction: 'out' | 'in'; queue: boolean; sent?: boolean }): void {
  db.run('INSERT OR IGNORE INTO remote_tickets (uuid, project_id, ticket_id, direction, sent, queue) VALUES (?, ?, ?, ?, ?, ?)', [t.uuid, t.project_id, t.ticket_id, t.direction, t.sent ? 1 : 0, t.queue ? 1 : 0]);
}

export function pendingOutTickets(db: Database, projectId: number): RemoteTicket[] {
  return db.query<RemoteTicket, [number]>("SELECT * FROM remote_tickets WHERE project_id = ? AND direction = 'out' AND sent = 0 ORDER BY uuid").all(projectId);
}

export function markTicketsSent(db: Database, uuids: string[]): void {
  for (const u of uuids) db.run('UPDATE remote_tickets SET sent = 1 WHERE uuid = ?', [u]);
}

export function knownRemoteTicket(db: Database, uuid: string): boolean {
  return !!db.query('SELECT 1 FROM remote_tickets WHERE uuid = ?').get(uuid);
}

export function remoteTicketByUuid(db: Database, uuid: string): RemoteTicket | null {
  return db.query<RemoteTicket, [string]>('SELECT * FROM remote_tickets WHERE uuid = ?').get(uuid) ?? null;
}

/** Tickets on this computer that only the box runs: the local scheduler must leave them alone. */
export function isRemoteOut(db: Database, ticketId: number): boolean {
  return !!db.query("SELECT 1 FROM remote_tickets WHERE ticket_id = ? AND direction = 'out'").get(ticketId);
}

export function remoteTicketForLocal(db: Database, ticketId: number, direction: 'in' | 'out'): RemoteTicket | null {
  return db.query<RemoteTicket, [number, string]>('SELECT * FROM remote_tickets WHERE ticket_id = ? AND direction = ?').get(ticketId, direction) ?? null;
}

// --- replies -----------------------------------------------------------------------------

interface ReplyRow {
  id: string;
  project_id: number;
  direction: 'out' | 'in';
  ref: string | null;
  name: string | null;
  body: string;
  now: number;
  at: number;
  sent: number;
  decision: string | null;
}

/** Client: queue a follow-up for the box (sent by the next sync). Returns the reply's id. */
export function addOutReply(db: Database, projectId: number, r: { ref?: string; name?: string; body: string; now?: boolean; decision?: ReplyFile['decision'] }): string {
  const id = newId();
  db.run("INSERT INTO remote_replies (id, project_id, direction, ref, name, body, now, at, sent, decision) VALUES (?, ?, 'out', ?, ?, ?, ?, ?, 0, ?)", [id, projectId, r.ref ?? null, r.name ?? null, r.body, r.now ? 1 : 0, Number(id.slice(0, 13)), r.decision ? JSON.stringify(r.decision) : null]);
  return id;
}

export function pendingOutReplies(db: Database, projectId: number): ReplyFile[] {
  return db
    .query<ReplyRow, [number]>("SELECT * FROM remote_replies WHERE project_id = ? AND direction = 'out' AND sent = 0 ORDER BY id")
    .all(projectId)
    .map((r) => ({ v: 1, id: r.id, project: '', ...(r.ref ? { ref: r.ref } : {}), ...(r.name ? { name: r.name } : {}), body: r.body, now: !!r.now, ...(r.decision ? { decision: JSON.parse(r.decision) } : {}), at: r.at }));
}

export function markRepliesSent(db: Database, ids: string[]): void {
  for (const id of ids) db.run('UPDATE remote_replies SET sent = 1 WHERE id = ?', [id]);
}

export function knownReply(db: Database, id: string): boolean {
  return !!db.query('SELECT 1 FROM remote_replies WHERE id = ?').get(id);
}

/** Box: remember a reply file has been handled, so it is applied once. */
export function recordInReply(db: Database, projectId: number, r: ReplyFile): void {
  db.run("INSERT OR IGNORE INTO remote_replies (id, project_id, direction, ref, name, body, now, at, sent, decision) VALUES (?, ?, 'in', ?, ?, ?, ?, ?, 1, ?)", [r.id, projectId, r.ref ?? null, r.name ?? null, r.body, r.now ? 1 : 0, r.at, r.decision ? JSON.stringify(r.decision) : null]);
}

// --- decisions (client side: the box's id <-> the local copy) ---------------------------------

export function mapDecision(db: Database, projectId: number, remoteId: string, localId: number): void {
  db.run('INSERT OR REPLACE INTO remote_decisions (project_id, remote_id, local_id) VALUES (?, ?, ?)', [projectId, remoteId, localId]);
}

export function localDecisionFor(db: Database, projectId: number, remoteId: string): number | null {
  return db.query<{ local_id: number }, [number, string]>('SELECT local_id FROM remote_decisions WHERE project_id = ? AND remote_id = ?').get(projectId, remoteId)?.local_id ?? null;
}

export function remoteDecisionFor(db: Database, localId: number): string | null {
  return db.query<{ remote_id: string }, [number]>('SELECT remote_id FROM remote_decisions WHERE local_id = ?').get(localId)?.remote_id ?? null;
}

// --- actions (resolve / reopen) ----------------------------------------------------------

/** Client: queue a resolve or reopen for the box. Returns the action's id. */
export function addOutAction(db: Database, projectId: number, a: { ref?: string; name?: string; action: 'resolve' | 'reopen' }): string {
  const id = newId();
  db.run("INSERT INTO remote_actions (id, project_id, direction, ref, name, action, at, sent) VALUES (?, ?, 'out', ?, ?, ?, ?, 0)", [id, projectId, a.ref ?? null, a.name ?? null, a.action, Number(id.slice(0, 13))]);
  return id;
}

export function pendingOutActions(db: Database, projectId: number): ActionFile[] {
  return db
    .query<{ id: string; ref: string | null; name: string | null; action: 'resolve' | 'reopen'; at: number }, [number]>("SELECT id, ref, name, action, at FROM remote_actions WHERE project_id = ? AND direction = 'out' AND sent = 0 ORDER BY id")
    .all(projectId)
    .map((r) => ({ v: 1, id: r.id, project: '', ...(r.ref ? { ref: r.ref } : {}), ...(r.name ? { name: r.name } : {}), action: r.action, at: r.at }));
}

export function markActionsSent(db: Database, ids: string[]): void {
  for (const id of ids) db.run('UPDATE remote_actions SET sent = 1 WHERE id = ?', [id]);
}

export function knownAction(db: Database, id: string): boolean {
  return !!db.query('SELECT 1 FROM remote_actions WHERE id = ?').get(id);
}

/** Box: remember an action file has been handled, so it is applied once. */
export function recordInAction(db: Database, projectId: number, a: ActionFile): void {
  db.run("INSERT OR IGNORE INTO remote_actions (id, project_id, direction, ref, name, action, at, sent) VALUES (?, ?, 'in', ?, ?, ?, ?, 1)", [a.id, projectId, a.ref ?? null, a.name ?? null, a.action, a.at]);
}

// --- messages ----------------------------------------------------------------------------

export interface StoredMessage {
  id: string;
  project_id: number;
  at: number;
  body: string; // the MessageFile as JSON
  direction: 'in' | 'out';
  posted: number; // out: 1 once it is on the remote
  read_at: number | null; // in: when you read it (salu notif)
}

export type NewMessage = Omit<MessageFile, 'v' | 'id' | 'at' | 'project' | 'from'> & { at?: number };

/** Box side: queue a message for the next sync. Safe to call from anywhere in the orchestrator process. */
export function enqueueMessage(db: Database, projectId: number, projectName: string, from: string, m: NewMessage): MessageFile {
  const id = newId(m.at);
  const at = Number(id.slice(0, 13));
  const msg: MessageFile = { ...m, v: 1, id, project: projectName, from, at };
  db.run("INSERT INTO remote_messages (id, project_id, at, body, direction, posted, read_at) VALUES (?, ?, ?, ?, 'out', 0, NULL)", [msg.id, projectId, at, JSON.stringify(msg)]);
  return msg;
}

export function pendingMessages(db: Database, projectId: number): StoredMessage[] {
  return db.query<StoredMessage, [number]>("SELECT * FROM remote_messages WHERE project_id = ? AND direction = 'out' AND posted = 0 ORDER BY id").all(projectId);
}

export function markMessagesPosted(db: Database, ids: string[]): void {
  for (const id of ids) db.run('UPDATE remote_messages SET posted = 1 WHERE id = ?', [id]);
}

export function knownMessage(db: Database, projectId: number, id: string): boolean {
  return !!db.query('SELECT 1 FROM remote_messages WHERE id = ? AND project_id = ?').get(id, projectId);
}

/** Client side: keep a message fetched from the box. Returns false when it was already stored. */
export function storeIncomingMessage(db: Database, projectId: number, m: MessageFile): boolean {
  const r = db.run("INSERT OR IGNORE INTO remote_messages (id, project_id, at, body, direction, posted, read_at) VALUES (?, ?, ?, ?, 'in', 1, NULL)", [m.id, projectId, m.at, JSON.stringify(m)]);
  return r.changes > 0;
}

export interface Notification extends MessageFile {
  projectId: number;
  read_at: number | null;
}

function toNotification(r: StoredMessage): Notification {
  return { ...(JSON.parse(r.body) as MessageFile), projectId: r.project_id, read_at: r.read_at };
}

/** What `salu notif` shows: messages from the boxes, newest last. Unread only unless `all`. */
export function listNotifications(db: Database, o: { all?: boolean; projectId?: number; limit?: number } = {}): Notification[] {
  const where = ["direction = 'in'"];
  const vals: (number | string)[] = [];
  if (!o.all) where.push('read_at IS NULL');
  if (o.projectId !== undefined) {
    where.push('project_id = ?');
    vals.push(o.projectId);
  }
  const rows = db.query<StoredMessage, any[]>(`SELECT * FROM remote_messages WHERE ${where.join(' AND ')} ORDER BY at DESC, id DESC LIMIT ${Math.max(1, o.limit ?? 200)}`).all(...vals);
  return rows.reverse().map(toNotification);
}

export function unreadCount(db: Database): number {
  return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM remote_messages WHERE direction = 'in' AND read_at IS NULL").get()!.n;
}

export function markRead(db: Database, ids: string[] | 'all'): number {
  if (ids === 'all') return db.run("UPDATE remote_messages SET read_at = ? WHERE direction = 'in' AND read_at IS NULL", [Date.now()]).changes;
  let n = 0;
  for (const id of ids) n += db.run("UPDATE remote_messages SET read_at = ? WHERE id = ? AND direction = 'in' AND read_at IS NULL", [Date.now(), id]).changes;
  return n;
}
