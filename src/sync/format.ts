/**
 * Wire format of the git transport. Documented in INTERFACES.md ("Git sync transport").
 *
 * Everything lives on the orphan branch `salu/inbox` of the project's git remote, as files that are
 * written once and never changed or deleted, each under a unique name. Two machines pushing at the
 * same time therefore never conflict: the loser fetches and pushes again.
 *
 *   salu-inbox/tickets/<id>.json    client -> box   a new ticket
 *   salu-inbox/replies/<id>.json    client -> box   a follow-up message on a ticket that already has a reply
 *   salu-inbox/messages/<id>.json   box -> client   something the orchestrator wants you to know
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const INBOX_BRANCH = 'salu/inbox';
export const TICKETS_DIR = 'salu-inbox/tickets';
export const REPLIES_DIR = 'salu-inbox/replies';
export const MESSAGES_DIR = 'salu-inbox/messages';
export const FORMAT_VERSION = 1;
export const MAX_FILE_BYTES = 64 * 1024;
export const REPLY_MAX = 16000;

let lastMs = 0;
/** `<13-digit epoch ms>-<8 hex>`: sorts by time (strictly increasing within a process), unique across machines. */
export function newId(at = Date.now()): string {
  lastMs = Math.max(at, lastMs + 1);
  return `${String(lastMs).padStart(13, '0')}-${randomBytes(4).toString('hex')}`;
}

const ID_RE = /^\d{13}-[0-9a-f]{8}$/;
export const isId = (s: unknown): s is string => typeof s === 'string' && ID_RE.test(s);

/** A ticket sent from your computer to the box. */
export interface TicketFile {
  v: 1;
  id: string;
  project: string;
  name: string;
  query: string;
  tags: Record<string, string>;
  labels: string[];
  priority: number;
  queue: boolean; // true: run it as soon as the box can; false: save it in the backlog
  at: number;
}

/** A follow-up prompt on a ticket (`salu reply`), sent from your computer or phone to the box. */
export interface ReplyFile {
  v: 1;
  id: string;
  project: string;
  ref?: string; // id of the ticket file the ticket was sent with (preferred)
  ticketId?: number; // else the ticket's number on the box (`ticket.id` of its messages)
  name?: string; // else the ticket's name on the box
  body: string;
  now: boolean; // move the ticket to the front of the queue
  at: number;
}

export type MessageType =
  | 'ticket.accepted'
  | 'ticket.started'
  | 'ticket.done'
  | 'ticket.blocked'
  | 'ticket.failed'
  | 'orchestrator.paused'
  | 'orchestrator.resumed'
  | 'note';
export const MESSAGE_TYPES: MessageType[] = ['ticket.accepted', 'ticket.started', 'ticket.done', 'ticket.blocked', 'ticket.failed', 'orchestrator.paused', 'orchestrator.resumed', 'note'];
export type MessageLevel = 'info' | 'success' | 'warn' | 'error';

/** Something the orchestrator on the box tells you. `salu notif` shows these. */
export interface MessageFile {
  v: 1;
  id: string;
  project: string;
  from: string; // the box's name
  at: number;
  type: MessageType;
  level: MessageLevel;
  title: string; // one line
  body?: string; // the detail: a summary, the error, the question
  ticket?: {
    ref?: string; // id of the ticket file that started it, when it came from a client
    name: string;
    id: number; // the ticket's number on the box
  };
  branch?: string; // the branch with the result (salu/<ticket>), when there is one
  question?: string; // blocked: what the ticket needs
  reply?: string; // done/blocked/failed: the worker's whole final reply (clipped to REPLY_MAX), what a follow-up answers
  until?: number; // paused: epoch ms it resumes
}

import { stripControl } from '../core/ansi.ts';

/**
 * Everything from the remote is untrusted text that ends up on a terminal: drop control characters
 * (ESC, BEL, C1 and so on; newline and tab stay) so it cannot carry escape sequences such as OSC 52.
 */
export { stripControl };
const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length <= max ? stripControl(v) : null);

/**
 * Optional signing: when SALU_REMOTE_KEY is set on both machines (shared out of band, never put in git),
 * every file carries `sig` = HMAC-SHA256 of its canonical JSON, and files without a valid one are ignored.
 * Without a key, anyone who can push to the remote can forge tickets, replies and messages.
 */
export function remoteKey(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.SALU_REMOTE_KEY?.trim() || null;
}

/** The loud warning for a box or client that syncs without SALU_REMOTE_KEY (null when a key is set). */
export function unsignedWarning(env: NodeJS.ProcessEnv = process.env): string | null {
  if (remoteKey(env)) return null;
  return 'SALU_REMOTE_KEY is not set: the inbox is NOT authenticated, so anyone who can push to the git remote can send this box tickets and forge its messages. Set the same secret on your computer and the box (share it outside git), and use a private repository.';
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => k !== 'sig' && o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export function signFile<T extends object>(o: T, key = remoteKey()): T & { sig?: string } {
  return key ? { ...o, sig: createHmac('sha256', key).update(canonical(o)).digest('hex') } : o;
}

function signatureOk(o: any, key = remoteKey()): boolean {
  if (!key) return true;
  if (typeof o?.sig !== 'string' || !/^[0-9a-f]{64}$/.test(o.sig)) return false;
  const want = createHmac('sha256', key).update(canonical(o)).digest();
  return timingSafeEqual(want, Buffer.from(o.sig, 'hex'));
}

/** Validate untrusted JSON from the remote. Returns null for anything that does not fit. */
export function parseTicketFile(text: string): TicketFile | null {
  if (text.length > MAX_FILE_BYTES) return null;
  let o: any;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object' || o.v !== FORMAT_VERSION || !isId(o.id) || !signatureOk(o)) return null;
  const name = str(o.name, 200);
  const query = str(o.query, 20000);
  if (!name?.trim() || query === null) return null;
  const tags: Record<string, string> = {};
  if (o.tags && typeof o.tags === 'object') for (const [k, v] of Object.entries(o.tags)) if (typeof v === 'string' && k.length <= 64 && v.length <= 2000) tags[stripControl(k)] = stripControl(v);
  const labels = Array.isArray(o.labels) ? o.labels.filter((l: unknown): l is string => typeof l === 'string' && l.length <= 64).slice(0, 50).map(stripControl) : [];
  const priority = Number.isInteger(o.priority) && o.priority >= 1 && o.priority <= 5 ? o.priority : 3;
  return { v: 1, id: o.id, project: str(o.project, 200) ?? '', name: name.trim(), query, tags, labels, priority, queue: o.queue !== false, at: Number.isFinite(o.at) ? o.at : 0 };
}

export function parseReplyFile(text: string): ReplyFile | null {
  if (text.length > MAX_FILE_BYTES) return null;
  let o: any;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object' || o.v !== FORMAT_VERSION || !isId(o.id) || !signatureOk(o)) return null;
  const body = str(o.body, 20000);
  if (!body?.trim()) return null;
  // The ticket is named either flat (ref, name) or as { ticket: { ref?, id?, name? } }, the shape messages use.
  const t = o.ticket && typeof o.ticket === 'object' ? o.ticket : {};
  const refRaw = o.ref ?? t.ref;
  const ref = isId(refRaw) ? refRaw : undefined;
  const name = str(o.name ?? t.name, 200)?.trim() || undefined;
  const ticketId = Number.isInteger(t.id) && t.id > 0 ? (t.id as number) : undefined;
  if (!ref && !name && !ticketId) return null;
  return { v: 1, id: o.id, project: str(o.project, 200) ?? '', ...(ref ? { ref } : {}), ...(ticketId ? { ticketId } : {}), ...(name ? { name } : {}), body, now: o.now === true, at: Number.isFinite(o.at) ? o.at : 0 };
}

export function parseMessageFile(text: string): MessageFile | null {
  if (text.length > MAX_FILE_BYTES) return null;
  let o: any;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object' || o.v !== FORMAT_VERSION || !isId(o.id) || !signatureOk(o)) return null;
  const title = str(o.title, 500);
  if (!title || !MESSAGE_TYPES.includes(o.type)) return null;
  const m: MessageFile = {
    v: 1,
    id: o.id,
    project: str(o.project, 200) ?? '',
    from: str(o.from, 100) ?? 'box',
    at: Number.isFinite(o.at) ? o.at : 0,
    type: o.type,
    level: ['info', 'success', 'warn', 'error'].includes(o.level) ? o.level : 'info',
    title,
  };
  const body = str(o.body, 20000);
  if (body) m.body = body;
  if (o.ticket && typeof o.ticket === 'object' && typeof o.ticket.name === 'string' && Number.isInteger(o.ticket.id)) {
    m.ticket = { name: stripControl(o.ticket.name.slice(0, 200)), id: o.ticket.id };
    if (isId(o.ticket.ref)) m.ticket.ref = o.ticket.ref;
  }
  const branch = str(o.branch, 200);
  if (branch) m.branch = branch;
  const question = str(o.question, 20000);
  if (question) m.question = question;
  const reply = str(o.reply, 20000);
  if (reply) m.reply = reply;
  if (Number.isFinite(o.until)) m.until = o.until;
  return m;
}

/**
 * Tags a ticket from the remote may not set: they would widen what the worker may do (permission, tools,
 * project) or let a pusher burn quota (max-turns, model, effort). The box's owner can allow some with
 * SALU_REMOTE_ALLOW_TAGS=model,effort,max-turns; permission, tools and project can never be allowed.
 */
export const REMOTE_FORBIDDEN_TAGS = ['permission', 'tools', 'project', 'max-turns', 'model', 'effort'];
export function remoteForbiddenTags(env: NodeJS.ProcessEnv = process.env): string[] {
  const allow = (env.SALU_REMOTE_ALLOW_TAGS ?? '').split(',').map((x) => x.trim()).filter((x) => x && !['permission', 'tools', 'project'].includes(x));
  return REMOTE_FORBIDDEN_TAGS.filter((t) => !allow.includes(t));
}
