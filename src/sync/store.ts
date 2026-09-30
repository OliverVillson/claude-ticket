import type { Database } from 'bun:sqlite';
import type { MessageFile } from './format.ts';
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
