/**
 * Wire format of the git transport. Documented in INTERFACES.md ("Git sync transport").
 *
 * Everything lives on the orphan branch `salu/inbox` of the project's git remote, as files that are
 * written once and never changed or deleted, each under a unique name. Two machines pushing at the
 * same time therefore never conflict: the loser fetches and pushes again.
 *
 *   salu-inbox/tickets/<id>.json    client -> box   a new ticket
 *   salu-inbox/replies/<id>.json    client -> box   a follow-up message on a ticket that already has a reply
 *   salu-inbox/actions/<id>.json    client -> box   resolve or reopen a ticket
 *   salu-inbox/messages/<id>.json   box -> client   something the orchestrator wants you to know
 */
import { userInfo } from 'node:os';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CliError } from '../core/errors.ts';
import { ticketHome } from '../core/paths.ts';

export const INBOX_BRANCH = 'salu/inbox';
export const TICKETS_DIR = 'salu-inbox/tickets';
export const REPLIES_DIR = 'salu-inbox/replies';
export const ACTIONS_DIR = 'salu-inbox/actions';
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
  by?: string; // who added it (co-working: several people send tickets to one project)
  sender?: Sender; // box only: who the signature proves (set by the verifier, never read from the file)
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
  decision?: { id: string; option?: number }; // this reply answers that decision (and picks option n, 0-based)
  sender?: Sender;
  at: number;
}

/** Resolve a ticket (it collapses out of the way) or reopen it. Replying to a resolved ticket reopens it too. */
export interface ActionFile {
  v: 1;
  id: string;
  project: string;
  ref?: string;
  ticketId?: number;
  name?: string;
  action: 'resolve' | 'reopen';
  sender?: Sender;
  at: number;
}

export interface ChecklistItem {
  text: string;
  state: 'todo' | 'doing' | 'done';
}
export interface Decision {
  id: string;
  question: string;
  context?: string;
  options: Array<{ label: string; consequence?: string }>;
  recommended?: number;
}
export interface Output {
  kind: 'branch' | 'pr' | 'file' | 'link';
  ref: string; // branch name, PR url or number, file path or url
  title?: string;
}

export type MessageType =
  | 'ticket.accepted'
  | 'ticket.started'
  | 'ticket.done'
  | 'ticket.blocked'
  | 'ticket.failed'
  | 'orchestrator.paused'
  | 'orchestrator.resumed'
  | 'ticket.state'
  | 'ticket.status'
  | 'ticket.decision'
  | 'ticket.output'
  | 'ticket.spawned'
  | 'note';
export const MESSAGE_TYPES: MessageType[] = ['ticket.accepted', 'ticket.started', 'ticket.done', 'ticket.blocked', 'ticket.failed', 'orchestrator.paused', 'orchestrator.resumed', 'ticket.state', 'ticket.status', 'ticket.decision', 'ticket.output', 'ticket.spawned', 'note'];
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
  state?: string; // ticket.state: the ticket's new state, in the words of the core (waiting, resolved, working, ...)
  checklist?: ChecklistItem[]; // ticket.status: the worker's live checklist, replacing the last one
  decision?: Decision; // ticket.decision: a question with options; answer it with a reply file carrying `decision`
  outputs?: Output[]; // ticket.output: what the worker made (branch, PR, files, links)
  by?: string; // ticket.accepted: who added the ticket (so teammates can show it as theirs)
  parent?: { ref?: string; name: string; id: number }; // ticket.spawned: `ticket` is a sub-thread a worker started; this is the thread that started it
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
  const fromEnv = env.SALU_REMOTE_KEY?.trim();
  if (fromEnv) return fromEnv;
  return env === process.env ? readKeyFile() : null;
}

/** Where `salu remote add` keeps the key: ~/.salu/remote.key (0600). The environment variable wins over it. */
export function keyFilePath(): string {
  return join(ticketHome(), 'remote.key');
}

export function readKeyFile(): string | null {
  try {
    const p = keyFilePath();
    return existsSync(p) ? readFileSync(p, 'utf8').trim() || null : null;
  } catch {
    return null;
  }
}

/** Save the signing key (this machine only, readable by you alone). */
export function saveKey(key: string): void {
  const p = keyFilePath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, key.trim() + '\n', { mode: 0o600 });
  chmodSync(p, 0o600);
}

export function generateKey(): string {
  return randomBytes(32).toString('hex');
}

/** Explicit opt-out of signing (SALU_REMOTE_ALLOW_UNSIGNED=1): the inbox is then unauthenticated. */
export function unsignedAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes)$/i.test(env.SALU_REMOTE_ALLOW_UNSIGNED ?? '');
}

/** Sync refuses to run without a signing key, unless the opt-out above is set. */
export function requireKey(): void {
  if (remoteKey() || unsignedAllowed()) return;
  throw new CliError('there is no signing key for the remote, so sync is refusing to run: anyone who can push to the git remote could send the box tickets. On the box, `salu remote add <project> --box` makes one; on your computer, `salu remote key --set <key>` (or SALU_REMOTE_KEY). To run without one anyway: SALU_REMOTE_ALLOW_UNSIGNED=1.');
}

/** The loud warning for a box or client that syncs without SALU_REMOTE_KEY (null when a key is set). */
export function unsignedWarning(env: NodeJS.ProcessEnv = process.env): string | null {
  if (remoteKey(env)) return null;
  return unsignedAllowed(env)
    ? 'SALU_REMOTE_ALLOW_UNSIGNED is set and there is no signing key: the inbox is NOT authenticated, so anyone who can push to the git remote can send the box tickets and forge its messages.'
    : 'there is no signing key (salu remote key --set <key>, or SALU_REMOTE_KEY), so sync will refuse to run.';
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => k !== 'sig' && k !== 'sigs' && o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/**
 * Per-person keys. A member's key is a token `<kid>.<secret>` (kid: 8 hex, the public name of the key; secret: 64 hex).
 * A client holding one signs every file with `kid` inside the signed JSON, so the box finds the right secret and
 * knows who sent it; one key can then be revoked without touching anyone else. A plain string (the shared key of
 * v1) works as before, without `kid`. The box signs its messages with the shared key (`sig`) and once more per
 * member (`sigs[kid]`), so a client that only holds its own key can still read them.
 */
const TOKEN_RE = /^([0-9a-f]{8})\.([0-9a-f]{64})$/;
export function parseToken(key: string | null | undefined): { kid: string; secret: string } | null {
  const m = key ? TOKEN_RE.exec(key.trim()) : null;
  return m ? { kid: m[1]!, secret: m[2]! } : null;
}
export function newMemberToken(): { kid: string; secret: string; token: string } {
  const kid = randomBytes(4).toString('hex');
  const secret = randomBytes(32).toString('hex');
  return { kid, secret, token: `${kid}.${secret}` };
}

const mac = (secret: string, o: unknown) => createHmac('sha256', secret).update(canonical(o)).digest();
const hexEq = (a: Buffer, hex: unknown) => typeof hex === 'string' && /^[0-9a-f]{64}$/.test(hex) && timingSafeEqual(a, Buffer.from(hex, 'hex'));

export function signFile<T extends object>(o: T, key = remoteKey()): T & { sig?: string; kid?: string } {
  if (!key) return o;
  const t = parseToken(key);
  if (t) {
    const withKid = { ...o, kid: t.kid };
    return { ...withKid, sig: mac(t.secret, withKid).toString('hex') };
  }
  return { ...o, sig: mac(key, o).toString('hex') };
}

/** Box: sign a message for the shared key (unless it is retired) and for each member's key. */
export function signMessageFor<T extends object>(o: T, shared: string | null, members: Array<{ kid: string; secret: string }>): T & { sig?: string; sigs?: Record<string, string> } {
  const base: T & { sig?: string } = shared && !parseToken(shared) ? signFile(o, shared) : o;
  if (!members.length) return base;
  return { ...base, sigs: Object.fromEntries(members.map((m) => [m.kid, mac(m.secret, o).toString('hex')])) };
}

/**
 * Does `o` carry a valid signature for `key`? With a member token (a client reading the box's messages) that is
 * the box's `sigs[kid]`; with the shared key it is `sig`; with no key anything goes (unsigned mode).
 */
export function signatureOk(o: any, key = remoteKey()): boolean {
  if (!key) return true;
  const t = parseToken(key);
  if (t) return hexEq(mac(t.secret, o), o?.sigs?.[t.kid]);
  return hexEq(mac(key, o), o?.sig);
}

/** A file signed by a member: `sig` over its JSON (including `kid`) under that member's secret. */
export const memberSigOk = (o: any, secret: string): boolean => hexEq(mac(secret, o), o?.sig);

/** Who verifies a file and, when its key belongs to one person, who that is. */
export type Sender = { name: string | null; role: 'admin' | 'member' | null };
export type Verifier = (o: any) => { ok: boolean; by?: string; sender?: Sender };
export const sharedVerifier: Verifier = (o) => ({ ok: signatureOk(o) });

/** A person's name from the remote: short, printable, no control characters. Null when it is not usable. */
export function personName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const n = stripControl(v).replace(/\s+/g, ' ').trim().slice(0, 40);
  return n || null;
}

/** The label that marks a ticket as someone's (`by-bob`). */
export function byLabel(name: string): string {
  return 'by-' + (name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'someone');
}

/** Who is adding tickets on this computer: SALU_USER, else the login name. */
export function whoAmI(env: NodeJS.ProcessEnv = process.env): string {
  return personName(env.SALU_USER) ?? personName(userInfo().username) ?? 'someone';
}

/** Validate untrusted JSON from the remote. Returns null for anything that does not fit. */
export function parseTicketFile(text: string, verify: Verifier = sharedVerifier): TicketFile | null {
  if (text.length > MAX_FILE_BYTES) return null;
  let o: any;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object' || o.v !== FORMAT_VERSION || !isId(o.id)) return null;
  const who = verify(o);
  if (!who.ok) return null;
  const name = str(o.name, 200);
  const query = str(o.query, 20000);
  if (!name?.trim() || query === null) return null;
  const tags: Record<string, string> = {};
  if (o.tags && typeof o.tags === 'object') for (const [k, v] of Object.entries(o.tags)) if (typeof v === 'string' && k.length <= 64 && v.length <= 2000) tags[stripControl(k)] = stripControl(v);
  const labels = Array.isArray(o.labels) ? o.labels.filter((l: unknown): l is string => typeof l === 'string' && l.length <= 64).slice(0, 50).map(stripControl) : [];
  const priority = Number.isInteger(o.priority) && o.priority >= 1 && o.priority <= 5 ? o.priority : 3;
  const by = who.by ?? personName(o.by); // a member's key decides who sent it, whatever the file says
  return { v: 1, id: o.id, project: str(o.project, 200) ?? '', name: name.trim(), query, tags, labels, priority, queue: o.queue !== false, ...(by ? { by } : {}), ...(who.sender ? { sender: who.sender } : {}), at: Number.isFinite(o.at) ? o.at : 0 };
}

export function parseReplyFile(text: string, verify: Verifier = sharedVerifier): ReplyFile | null {
  if (text.length > MAX_FILE_BYTES) return null;
  let o: any;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object' || o.v !== FORMAT_VERSION || !isId(o.id)) return null;
  const who = verify(o);
  if (!who.ok) return null;
  const body = str(o.body, 20000);
  if (!body?.trim()) return null;
  const t = ticketRef(o);
  if (!t) return null;
  let decision: ReplyFile['decision'];
  if (o.decision && typeof o.decision === 'object') {
    const did = str(o.decision.id, 64);
    if (did) decision = { id: did, ...(Number.isInteger(o.decision.option) && o.decision.option >= 0 && o.decision.option < 10 ? { option: o.decision.option as number } : {}) };
  }
  return { v: 1, id: o.id, project: str(o.project, 200) ?? '', ...t, body, now: o.now === true, ...(decision ? { decision } : {}), ...(who.sender ? { sender: who.sender } : {}), at: Number.isFinite(o.at) ? o.at : 0 };
}

/**
 * The ticket a client file is about: flat (ref, name) or as { ticket: { ref?, id?, name? } }, the shape
 * messages use. Null when it names none.
 */
function ticketRef(o: any): { ref?: string; ticketId?: number; name?: string } | null {
  const t = o.ticket && typeof o.ticket === 'object' ? o.ticket : {};
  const refRaw = o.ref ?? t.ref;
  const ref = isId(refRaw) ? refRaw : undefined;
  const name = str(o.name ?? t.name, 200)?.trim() || undefined;
  const ticketId = Number.isInteger(t.id) && t.id > 0 ? (t.id as number) : undefined;
  if (!ref && !name && !ticketId) return null;
  return { ...(ref ? { ref } : {}), ...(ticketId ? { ticketId } : {}), ...(name ? { name } : {}) };
}

export function parseActionFile(text: string, verify: Verifier = sharedVerifier): ActionFile | null {
  if (text.length > MAX_FILE_BYTES) return null;
  let o: any;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object' || o.v !== FORMAT_VERSION || !isId(o.id)) return null;
  const who = verify(o);
  if (!who.ok) return null;
  if (o.action !== 'resolve' && o.action !== 'reopen') return null;
  const t = ticketRef(o);
  if (!t) return null;
  return { v: 1, id: o.id, project: str(o.project, 200) ?? '', ...t, action: o.action, ...(who.sender ? { sender: who.sender } : {}), at: Number.isFinite(o.at) ? o.at : 0 };
}

export function parseMessageFile(text: string, verify: Verifier = sharedVerifier): MessageFile | null {
  if (text.length > MAX_FILE_BYTES) return null;
  let o: any;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object' || o.v !== FORMAT_VERSION || !isId(o.id)) return null;
  const who = verify(o);
  if (!who.ok) return null;
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
  const by = personName(o.by);
  if (by) m.by = by;
  const branch = str(o.branch, 200);
  if (branch) m.branch = branch;
  const question = str(o.question, 20000);
  if (question) m.question = question;
  const reply = str(o.reply, 20000);
  if (reply) m.reply = reply;
  if (Number.isFinite(o.until)) m.until = o.until;
  const state = typeof o.state === 'string' && /^[a-z][a-z-]{0,23}$/.test(o.state) ? o.state : null;
  if (state) m.state = state;
  if (Array.isArray(o.checklist)) {
    const items = o.checklist
      .slice(0, 50)
      .map((x: any) => ({ text: str(x?.text, 200), state: x?.state }))
      .filter((x: any): x is ChecklistItem => !!x.text && ['todo', 'doing', 'done'].includes(x.state));
    if (items.length) m.checklist = items;
  }
  if (o.decision && typeof o.decision === 'object') {
    const id = str(o.decision.id, 64);
    const question = str(o.decision.question, 1000);
    const context = str(o.decision.context, 1200) ?? undefined;
    const options = Array.isArray(o.decision.options)
      ? o.decision.options.slice(0, 4).map((x: any) => ({ label: str(x?.label, 100), consequence: str(x?.consequence, 500) ?? undefined })).filter((x: any) => !!x.label)
      : [];
    if (id && question && options.length >= 2) {
      const rec = Number.isInteger(o.decision.recommended) && o.decision.recommended >= 0 && o.decision.recommended < options.length ? (o.decision.recommended as number) : undefined;
      m.decision = { id, question, ...(context ? { context } : {}), options: options.map((x: any) => ({ label: x.label as string, ...(x.consequence ? { consequence: x.consequence as string } : {}) })), ...(rec !== undefined ? { recommended: rec } : {}) };
    }
  }
  if (o.parent && typeof o.parent === 'object' && typeof o.parent.name === 'string' && Number.isInteger(o.parent.id)) {
    m.parent = { name: stripControl(o.parent.name.slice(0, 200)), id: o.parent.id };
    if (isId(o.parent.ref)) m.parent.ref = o.parent.ref;
  }
  if (Array.isArray(o.outputs)) {
    const outs = o.outputs
      .slice(0, 20)
      .map((x: any) => ({ kind: x?.kind, ref: str(x?.ref, 500), title: str(x?.title, 200) ?? undefined }))
      .filter((x: any) => ['branch', 'pr', 'file', 'link'].includes(x.kind) && !!x.ref);
    if (outs.length) m.outputs = outs.map((x: any) => ({ kind: x.kind, ref: x.ref as string, ...(x.title ? { title: x.title as string } : {}) }));
  }
  return m;
}

/**
 * Tags a ticket from the remote may not set: they would widen what the worker may do (permission, tools,
 * project) or let a pusher burn quota (max-turns, model, effort). The box's owner can allow some with
 * SALU_REMOTE_ALLOW_TAGS=model,effort,max-turns; permission, tools and project can never be allowed.
 */
export const REMOTE_FORBIDDEN_TAGS = ['permission', 'tools', 'project', 'seat', 'max-turns', 'model', 'effort'];
export function remoteForbiddenTags(env: NodeJS.ProcessEnv = process.env): string[] {
  const allow = (env.SALU_REMOTE_ALLOW_TAGS ?? '').split(',').map((x) => x.trim()).filter((x) => x && !['permission', 'tools', 'project', 'seat'].includes(x));
  return REMOTE_FORBIDDEN_TAGS.filter((t) => !allow.includes(t));
}
