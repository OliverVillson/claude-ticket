import type { Database } from 'bun:sqlite';
import { hostname } from 'node:os';
import type { Project, TicketView } from '../db/types.ts';
import { addTurn, createTicket, getProjectById, getTicketById, replyToTicket, updateTicket, listTickets } from '../db/queries.ts';
import { ticketLabels, ticketTags } from '../db/types.ts';
import { CliError } from '../core/errors.ts';
import { kernelPath, isGitRepo } from '../core/kernel.ts';
import { existsSync } from 'node:fs';
import { git, gitProblem, inboxDir, exchange, readDir } from './git.ts';
import { MESSAGES_DIR, REMOTE_FORBIDDEN_TAGS, REPLIES_DIR, TICKETS_DIR, newId, parseMessageFile, parseReplyFile, parseTicketFile, type MessageFile, type ReplyFile, type TicketFile } from './format.ts';
import {
  addOutReply,
  addRemoteTicket,
  knownReply,
  markRepliesSent,
  pendingOutReplies,
  recordInReply,
  remoteTicketForLocal,
  enqueueMessage,
  getRemote,
  knownMessage,
  knownRemoteTicket,
  listRemotes,
  markMessagesPosted,
  markSynced,
  markTicketsSent,
  pendingMessages,
  pendingOutTickets,
  remoteTicketByUuid,
  storeIncomingMessage,
  type Remote,
} from './store.ts';

/** The box's name in messages: SALU_BOX_NAME, else the host name. */
export function boxName(): string {
  return process.env.SALU_BOX_NAME?.trim() || hostname();
}

/** Client: record a new local ticket so the next sync sends it to the box. */
export function publishTicket(db: Database, project: Project, t: TicketView, o: { queue: boolean }): string {
  const uuid = newId();
  addRemoteTicket(db, { uuid, project_id: project.id, ticket_id: t.id, direction: 'out', queue: o.queue });
  return uuid;
}

/** Client: send a follow-up on a ticket that was sent to the box (the local turn is already recorded). Returns false when the ticket did not go through this project's remote. */
export function publishReply(db: Database, project: Project, t: TicketView, body: string, o: { now?: boolean } = {}): boolean {
  const rt = remoteTicketForLocal(db, t.id, 'out');
  if (!rt || getRemote(db, project.id)?.role !== 'client') return false;
  addOutReply(db, project.id, { ref: rt.uuid, name: t.name, body, now: o.now });
  return true;
}

/** Box: apply a follow-up from the client. Returns a message for the client when it cannot be applied. */
function applyReply(db: Database, project: Project, r: ReplyFile): void {
  const say = (title: string, level: 'info' | 'warn', ticket?: { ref?: string; name: string; id: number }) => enqueueMessage(db, project.id, project.name, boxName(), { type: ticket && level === 'info' ? 'ticket.accepted' : 'note', level, title, ...(ticket ? { ticket } : {}) });
  let id: number | null = r.ref ? (remoteTicketByUuid(db, r.ref)?.ticket_id ?? null) : null;
  if (id === null && r.name) id = listTickets(db, { projectId: project.id, recursive: false }).find((x) => x.name === r.name)?.id ?? null;
  const t = id === null ? null : getTicketById(db, id);
  if (!t) return void say(`Could not find the ticket for your reply${r.name ? ` ("${r.name}")` : ''}`, 'warn');
  const ticket = { ...(r.ref ? { ref: r.ref } : {}), name: t.name, id: t.id };
  try {
    replyToTicket(db, t.id, r.body, { now: r.now });
    say(`Got your reply on "${t.name}"${t.status === 'running' ? ', it is the next turn' : ', queued to run'}`, 'info', ticket);
  } catch (e: any) {
    say(`Your reply on "${t.name}" was not applied: ${String(e?.message ?? e)}`, 'warn', ticket);
  }
}

function ticketFile(db: Database, project: Project, uuid: string): TicketFile | null {
  const rt = remoteTicketByUuid(db, uuid);
  const t = rt?.ticket_id ? getTicketById(db, rt.ticket_id) : null;
  if (!rt || !t) return null;
  return { v: 1, id: uuid, project: project.name, name: t.name, query: t.query, tags: ticketTags(t), labels: ticketLabels(t), priority: t.priority, queue: !!rt.queue, at: t.created_at };
}

/** Box: make a ticket that arrived from a client. Returns the local ticket, or null when it is not valid here. */
function acceptTicket(db: Database, project: Project, f: TicketFile): TicketView {
  const tags = { ...f.tags };
  for (const k of REMOTE_FORBIDDEN_TAGS) delete tags[k];
  let name = f.name;
  for (let n = 2; ; n++) {
    try {
      const t = createTicket(db, { project_id: project.id, name, query: f.query, tags, labels: f.labels, priority: f.priority, status: f.queue ? 'todo' : 'backlog' });
      addRemoteTicket(db, { uuid: f.id, project_id: project.id, ticket_id: t.id, direction: 'in', queue: f.queue, sent: true });
      return t;
    } catch (e) {
      if (!(e instanceof CliError) || !/already exists/.test(e.message) || n > 50) throw e;
      name = `${f.name} (${n})`;
    }
  }
}

/** Client: what a message from the box does to the local copy of the ticket. */
function applyMessage(db: Database, m: MessageFile): void {
  const ref = m.ticket?.ref;
  const rt = ref ? remoteTicketByUuid(db, ref) : null;
  if (!rt || rt.direction !== 'out' || !rt.ticket_id || !getTicketById(db, rt.ticket_id)) return;
  // The worker's whole reply is what a follow-up answers: keep it as the ticket's latest turn.
  if (m.reply && ['ticket.done', 'ticket.blocked', 'ticket.failed'].includes(m.type)) addTurn(db, rt.ticket_id, 'assistant', m.reply);
  switch (m.type) {
    case 'ticket.started':
      updateTicket(db, rt.ticket_id, { status: 'running', error: null });
      break;
    case 'ticket.done':
      updateTicket(db, rt.ticket_id, { status: 'done', error: null, finished_at: m.at });
      break;
    case 'ticket.blocked':
      updateTicket(db, rt.ticket_id, { status: 'blocked', error: m.question ?? m.body ?? m.title });
      break;
    case 'ticket.failed':
      updateTicket(db, rt.ticket_id, { status: 'failed', error: m.body ?? m.title, finished_at: m.at });
      break;
  }
}

export interface SyncSummary {
  project: string;
  role: 'client' | 'box';
  ticketsSent: number;
  ticketsReceived: number;
  repliesSent: number;
  repliesReceived: number;
  messagesSent: number;
  messagesReceived: number;
  branchesPushed: string[];
}

/** One round trip with the project's remote: send what is waiting, read what arrived, act on it. */
export function syncProject(db: Database, project: Project, remote: Remote = getRemote(db, project.id)!): SyncSummary {
  if (!remote) throw new CliError(`project "${project.name}" has no remote (salu remote add "${project.name}" <git-url>)`);
  const s: SyncSummary = { project: project.name, role: remote.role, ticketsSent: 0, ticketsReceived: 0, repliesSent: 0, repliesReceived: 0, messagesSent: 0, messagesReceived: 0, branchesPushed: [] };
  const dir = inboxDir(project.name);
  try {
    // Round 1: push anything waiting, then read the branch.
    const files: Record<string, string> = {};
    const outTickets = remote.role === 'client' ? pendingOutTickets(db, project.id) : [];
    for (const rt of outTickets) {
      const f = ticketFile(db, project, rt.uuid);
      if (f) files[`${TICKETS_DIR}/${f.id}.json`] = JSON.stringify(f, null, 2) + '\n';
    }
    const outReplies = remote.role === 'client' ? pendingOutReplies(db, project.id) : [];
    for (const r of outReplies) files[`${REPLIES_DIR}/${r.id}.json`] = JSON.stringify({ ...r, project: project.name }, null, 2) + '\n';
    const outMessages = remote.role === 'box' ? pendingMessages(db, project.id) : [];
    for (const m of outMessages) files[`${MESSAGES_DIR}/${m.id}.json`] = JSON.stringify(JSON.parse(m.body), null, 2) + '\n';
    exchange(dir, remote.url, files);
    markTicketsSent(db, outTickets.map((t) => t.uuid));
    markMessagesPosted(db, outMessages.map((m) => m.id));
    markRepliesSent(db, outReplies.map((r) => r.id));
    s.repliesSent = outReplies.length;
    s.ticketsSent = outTickets.length;
    s.messagesSent = outMessages.length;

    if (remote.role === 'box') {
      for (const { text } of readDir(dir, TICKETS_DIR, () => true)) {
        const f = parseTicketFile(text);
        if (!f || knownRemoteTicket(db, f.id)) continue;
        const t = acceptTicket(db, project, f);
        s.ticketsReceived++;
        enqueueMessage(db, project.id, project.name, boxName(), {
          type: 'ticket.accepted',
          level: 'info',
          title: `Got "${t.name}"${f.queue ? ', queued to run' : ', saved in the backlog'}`,
          ticket: { ref: f.id, name: t.name, id: t.id },
        });
      }
      // Replies come after tickets, so a reply can follow the ticket it is about in the same round.
      for (const { text } of readDir(dir, REPLIES_DIR, () => true)) {
        const r = parseReplyFile(text);
        if (!r || knownReply(db, r.id)) continue;
        recordInReply(db, project.id, r);
        applyReply(db, project, r);
        s.repliesReceived++;
      }
      // Round 2: the acknowledgements (and anything the orchestrator queued meanwhile).
      const more = pendingMessages(db, project.id);
      if (more.length) {
        const extra: Record<string, string> = {};
        for (const m of more) extra[`${MESSAGES_DIR}/${m.id}.json`] = JSON.stringify(JSON.parse(m.body), null, 2) + '\n';
        exchange(dir, remote.url, extra);
        markMessagesPosted(db, more.map((m) => m.id));
        s.messagesSent += more.length;
      }
      s.branchesPushed = pushResultBranches(project, remote);
    } else {
      for (const { text } of readDir(dir, MESSAGES_DIR, () => true)) {
        const m = parseMessageFile(text);
        if (!m || knownMessage(db, project.id, m.id)) continue;
        if (storeIncomingMessage(db, project.id, m)) {
          s.messagesReceived++;
          applyMessage(db, m);
        }
      }
      fetchResultBranches(project, remote);
    }
    markSynced(db, project.id, null);
  } catch (e: any) {
    markSynced(db, project.id, String(e?.message ?? e));
    throw e;
  }
  return s;
}

/** Box: send the salu/<ticket> branches the agents made (from the kernel when the project has one). */
function pushResultBranches(project: Project, remote: Remote): string[] {
  const dir = project.sandbox && existsSync(kernelPath(project.name)) ? kernelPath(project.name) : project.path;
  if (!isGitRepo(dir)) return [];
  const list = git(dir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/salu/']);
  const branches = list.out.split('\n').map((b) => b.trim()).filter((b) => b && b !== 'salu/inbox');
  if (!branches.length) return [];
  const p = git(dir, ['push', '-q', remote.url, ...branches.map((b) => `refs/heads/${b}:refs/heads/${b}`)]);
  if (!p.ok) throw new CliError(`could not push result branches to ${remote.url}: ${gitProblem(p.err, remote.url)}`);
  return branches;
}

/** Client: bring the box's result branches into the project's own repo as remote-tracking refs (salu-box/*). */
function fetchResultBranches(project: Project, remote: Remote): void {
  if (!isGitRepo(project.path)) return;
  git(project.path, ['fetch', '-q', remote.url, '+refs/heads/salu/*:refs/remotes/salu-box/*']); // best effort
}

/** Sync every project that has a remote. Errors are returned, not thrown, so one bad remote does not stop the rest. */
export function syncAll(db: Database, only?: number[]): Array<{ project: string; summary?: SyncSummary; error?: string }> {
  const out: Array<{ project: string; summary?: SyncSummary; error?: string }> = [];
  for (const r of listRemotes(db)) {
    if (only && !only.includes(r.project_id)) continue;
    const p = getProjectById(db, r.project_id);
    if (!p) continue;
    try {
      out.push({ project: p.name, summary: syncProject(db, p, r) });
    } catch (e: any) {
      out.push({ project: p.name, error: String(e?.message ?? e) });
    }
  }
  return out;
}
