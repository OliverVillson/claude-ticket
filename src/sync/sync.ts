import { loadNtfy, publishNtfy } from './ntfy.ts';
import type { Database } from 'bun:sqlite';
import { hostname } from 'node:os';
import type { Project, TicketView } from '../db/types.ts';
import { addTurn, createTicket, getProjectById, getTicketById, replyToTicket, updateTicket, listTickets } from '../db/queries.ts';
import { TICKET_STATUSES, ticketLabels, ticketTags, type TicketStatus } from '../db/types.ts';
import { CliError } from '../core/errors.ts';
import { kernelPath, isGitRepo } from '../core/kernel.ts';
import { existsSync } from 'node:fs';
import { git, gitProblem, inboxDir, exchange, readDir, rewriteInbox } from './git.ts';
import * as core from '../db/queries.ts';
import { announceAllSpawned } from './events.ts';
import { addDecision, addOutput, answerDecision, getDecision, setChecklist } from '../threads/store.ts';
import { answerFromReply, answerOpenWithText } from '../threads/decide.ts';
import { ACTIONS_DIR, parseActionFile, type ActionFile, MESSAGES_DIR, remoteForbiddenTags, requireKey, signFile, signatureOk, REPLIES_DIR, TICKETS_DIR, newId, parseMessageFile, parseReplyFile, parseTicketFile, type MessageFile, type ReplyFile, type TicketFile } from './format.ts';
import {
  addOutAction,
  localDecisionFor,
  mapDecision,
  remoteDecisionFor,
  addOutReply,
  knownAction,
  markActionsSent,
  pendingOutActions,
  recordInAction,
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

/**
 * Client: answer one of the box's decisions (`salu reply --pick`). `option` is 0-based; `body` is what the
 * worker is told. Returns false when the ticket or the decision did not come through this project's remote.
 */
export function publishDecisionPick(db: Database, project: Project, t: TicketView, localDecisionId: number, option: number, body: string, o: { now?: boolean } = {}): boolean {
  const rt = remoteTicketForLocal(db, t.id, 'out');
  const remoteId = remoteDecisionFor(db, localDecisionId);
  if (!rt || !remoteId || getRemote(db, project.id)?.role !== 'client') return false;
  addOutReply(db, project.id, { ref: rt.uuid, name: t.name, body, now: o.now, decision: { id: remoteId, option } });
  return true;
}

/** Client: send a resolve or reopen for a ticket that runs on the box. Returns false when the ticket did not go through this project's remote. */
export function publishAction(db: Database, project: Project, t: TicketView, action: 'resolve' | 'reopen'): boolean {
  const rt = remoteTicketForLocal(db, t.id, 'out');
  if (!rt || getRemote(db, project.id)?.role !== 'client') return false;
  addOutAction(db, project.id, { ref: rt.uuid, name: t.name, action });
  return true;
}

/** Box: the ticket a client file is about (by ref, else box number, else name), or null. */
function findTicket(db: Database, project: Project, r: { ref?: string; ticketId?: number; name?: string }): TicketView | null {
  let id: number | null = r.ref ? (remoteTicketByUuid(db, r.ref)?.ticket_id ?? null) : null;
  if (id === null && r.ticketId) {
    const t = getTicketById(db, r.ticketId);
    if (t && t.project_id === project.id) id = t.id;
  }
  if (id === null && r.name) id = listTickets(db, { projectId: project.id, recursive: false }).find((x) => x.name === r.name)?.id ?? null;
  return id === null ? null : getTicketById(db, id);
}

/** Overrides for the core's resolve (`resolveTicketById`) and reopen (`queueTicket`), for tests. */
export const threadOps: { resolve?: (db: Database, id: number) => TicketView | void; reopen?: (db: Database, id: number) => TicketView | void } = {};

/**
 * Box: resolve or reopen a ticket for the client, with the core's operations (`salu resolve` and
 * `salu reopen "name"` without a message: resolveTicketById / queueTicket in src/db/queries.ts). A refusal
 * (resolving a running ticket, say) comes back as a warning note. Reopening with a message is a reply file.
 */
function applyAction(db: Database, project: Project, a: ActionFile): void {
  const say = (title: string, level: 'info' | 'warn', t?: TicketView) =>
    enqueueMessage(db, project.id, project.name, boxName(), {
      type: t && level === 'info' ? 'ticket.state' : 'note',
      level,
      title,
      ...(t ? { ticket: { ...(a.ref ? { ref: a.ref } : {}), name: t.name, id: t.id }, state: t.status } : {}),
    });
  const t = findTicket(db, project, a);
  if (!t) return void say(`Could not find the ticket to ${a.action}${a.name ? ` ("${a.name}")` : ''}`, 'warn');
  const op = threadOps[a.action] ?? (a.action === 'resolve' ? core.resolveTicketById : core.queueTicket);
  try {
    const after = (op as (db: Database, id: number) => TicketView | void)(db, t.id) ?? getTicketById(db, t.id) ?? t;
    say(`${a.action === 'resolve' ? 'Resolved' : 'Reopened'} "${after.name}"`, 'info', after);
  } catch (e: any) {
    say(`Could not ${a.action} "${t.name}": ${String(e?.message ?? e)}`, 'warn', t);
  }
}

/** Box: apply a follow-up from the client. Returns a message for the client when it cannot be applied. */
function applyReply(db: Database, project: Project, r: ReplyFile): void {
  const say = (title: string, level: 'info' | 'warn', ticket?: { ref?: string; name: string; id: number }) => enqueueMessage(db, project.id, project.name, boxName(), { type: ticket && level === 'info' ? 'ticket.accepted' : 'note', level, title, ...(ticket ? { ticket } : {}) });
  const t = findTicket(db, project, r);
  if (!t) return void say(`Could not find the ticket for your reply${r.name ? ` ("${r.name}")` : ''}`, 'warn');
  const ticket = { ...(r.ref ? { ref: r.ref } : {}), name: t.name, id: t.id };
  try {
    // A pick of the recommended option only records the answer (the worker already went with it); anything
    // else is a reply the worker must hear. Typed words answer every open decision, like the local CLI.
    const picked = r.decision ? getDecision(db, Number(r.decision.id)) : null;
    if (r.decision && picked && picked.ticket_id === t.id && r.decision.option === picked.recommended) {
      answerFromReply(db, t.id, r.decision, r.body);
      return void say(`Recorded your answer on "${t.name}": the worker already went with it`, 'info', ticket);
    }
    replyToTicket(db, t.id, r.body, { now: r.now });
    if (r.decision) answerFromReply(db, t.id, r.decision, r.body);
    else answerOpenWithText(db, t.id, r.body);
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
  for (const k of remoteForbiddenTags()) delete tags[k];
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

/** Client: a sub-thread a worker started on the box becomes a local copy, linked to its parent when we know it. */
function applySpawned(db: Database, m: MessageFile, projectId: number): void {
  const ref = m.ticket?.ref;
  if (!ref || !m.ticket || knownRemoteTicket(db, ref)) return;
  let name = m.ticket.name;
  for (let n = 2; ; n++) {
    try {
      const t = createTicket(db, { project_id: projectId, name, query: m.body ?? m.title, status: 'backlog' });
      addRemoteTicket(db, { uuid: ref, project_id: projectId, ticket_id: t.id, direction: 'out', queue: true, sent: true });
      const parentLocal = m.parent?.ref ? remoteTicketByUuid(db, m.parent.ref)?.ticket_id : null;
      if (parentLocal) db.run('UPDATE tickets SET parent_id = ? WHERE id = ?', [parentLocal, t.id]);
      if (m.state && (TICKET_STATUSES as string[]).includes(m.state)) updateTicket(db, t.id, { status: m.state as TicketStatus });
      return;
    } catch (e) {
      if (!(e instanceof CliError) || !/already exists/.test(e.message) || n > 50) throw e;
      name = `${m.ticket.name} (${n})`;
    }
  }
}

/** Client: what a message from the box does to the local copy of the ticket. */
function applyMessage(db: Database, m: MessageFile, projectId: number): void {
  if (m.type === 'ticket.spawned') return void applySpawned(db, m, projectId);
  const ref = m.ticket?.ref;
  const rt = ref ? remoteTicketByUuid(db, ref) : null;
  if (!rt || rt.direction !== 'out' || !rt.ticket_id || !getTicketById(db, rt.ticket_id)) return;
  // The worker's whole reply is what a follow-up answers: keep it as the ticket's latest turn.
  if (m.reply && ['ticket.done', 'ticket.blocked', 'ticket.failed'].includes(m.type)) addTurn(db, rt.ticket_id, 'assistant', m.reply);
  const local = rt.ticket_id;
  if (m.type === 'ticket.status' && m.checklist) setChecklist(db, local, m.checklist);
  if (m.type === 'ticket.output' && m.outputs) for (const o of m.outputs) addOutput(db, local, { kind: o.kind, ref: o.ref, title: o.title });
  if (m.type === 'ticket.decision' && m.decision && !localDecisionFor(db, projectId, m.decision.id)) {
    const d = m.decision;
    const row = addDecision(db, local, { question: d.question, context: d.context, options: d.options.map((x) => ({ label: x.label, consequence: x.consequence ?? '' })), recommended: d.recommended ?? 0 });
    mapDecision(db, projectId, d.id, row.id);
  }
  switch (m.type) {
    case 'ticket.started':
      updateTicket(db, rt.ticket_id, { status: 'running', error: null });
      break;
    case 'ticket.state':
      // Resolved (stored as done), reopened (todo) and so on: the stored statuses are the vocabulary.
      if (m.state && (TICKET_STATUSES as string[]).includes(m.state)) updateTicket(db, rt.ticket_id, { status: m.state as TicketStatus });
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
  actionsSent: number;
  actionsReceived: number;
  messagesSent: number;
  messagesReceived: number;
  branchesPushed: string[];
}

/** Tell the phone (ntfy, when set up with `salu remote ntfy`) about messages that just went out. */
function notifyPhone(sent: { body: string }[]): void {
  const cfg = loadNtfy();
  if (!cfg) return;
  for (const m of sent) {
    try {
      publishNtfy(JSON.parse(m.body), cfg);
    } catch {
      /* best effort */
    }
  }
}

/** One round trip with the project's remote: send what is waiting, read what arrived, act on it. */
export function syncProject(db: Database, project: Project, remote: Remote = getRemote(db, project.id)!): SyncSummary {
  if (!remote) throw new CliError(`project "${project.name}" has no remote (salu remote add "${project.name}" <git-url>)`);
  requireKey();
  const s: SyncSummary = { project: project.name, role: remote.role, ticketsSent: 0, ticketsReceived: 0, repliesSent: 0, repliesReceived: 0, actionsSent: 0, actionsReceived: 0, messagesSent: 0, messagesReceived: 0, branchesPushed: [] };
  const dir = inboxDir(project.name);
  try {
    // Round 1: push anything waiting, then read the branch.
    const files: Record<string, string> = {};
    const outTickets = remote.role === 'client' ? pendingOutTickets(db, project.id) : [];
    for (const rt of outTickets) {
      const f = ticketFile(db, project, rt.uuid);
      if (f) files[`${TICKETS_DIR}/${f.id}.json`] = JSON.stringify(signFile(f), null, 2) + '\n';
    }
    const outReplies = remote.role === 'client' ? pendingOutReplies(db, project.id) : [];
    for (const r of outReplies) files[`${REPLIES_DIR}/${r.id}.json`] = JSON.stringify(signFile({ ...r, project: project.name }), null, 2) + '\n';
    const outActions = remote.role === 'client' ? pendingOutActions(db, project.id) : [];
    for (const a of outActions) files[`${ACTIONS_DIR}/${a.id}.json`] = JSON.stringify(signFile({ ...a, project: project.name }), null, 2) + '\n';
    const outMessages = remote.role === 'box' ? pendingMessages(db, project.id) : [];
    for (const m of outMessages) files[`${MESSAGES_DIR}/${m.id}.json`] = JSON.stringify(signFile(JSON.parse(m.body)), null, 2) + '\n';
    exchange(dir, remote.url, files);
    markTicketsSent(db, outTickets.map((t) => t.uuid));
    markMessagesPosted(db, outMessages.map((m) => m.id));
    notifyPhone(outMessages);
    markRepliesSent(db, outReplies.map((r) => r.id));
    markActionsSent(db, outActions.map((a) => a.id));
    s.actionsSent = outActions.length;
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
      // Replies and resolve/reopen are applied together in id (time) order, so "resolve, then reply" from a
      // phone in one sync ends with the ticket working again, not resolved with the reply lost.
      const todo: Array<{ id: string; run: () => void }> = [];
      for (const { text } of readDir(dir, REPLIES_DIR, () => true)) {
        const r = parseReplyFile(text);
        if (!r || knownReply(db, r.id)) continue;
        todo.push({ id: r.id, run: () => (recordInReply(db, project.id, r), applyReply(db, project, r), void s.repliesReceived++) });
      }
      for (const { text } of readDir(dir, ACTIONS_DIR, () => true)) {
        const a = parseActionFile(text);
        if (!a || knownAction(db, a.id)) continue;
        todo.push({ id: a.id, run: () => (recordInAction(db, project.id, a), applyAction(db, project, a), void s.actionsReceived++) });
      }
      for (const x of todo.sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0))) x.run();
      announceAllSpawned(db, project.id);
      // Round 2: the acknowledgements (and anything the orchestrator queued meanwhile).
      const more = pendingMessages(db, project.id);
      if (more.length) {
        const extra: Record<string, string> = {};
        for (const m of more) extra[`${MESSAGES_DIR}/${m.id}.json`] = JSON.stringify(signFile(JSON.parse(m.body)), null, 2) + '\n';
        exchange(dir, remote.url, extra);
        markMessagesPosted(db, more.map((m) => m.id));
        notifyPhone(more);
        s.messagesSent += more.length;
      }
      s.branchesPushed = pushResultBranches(project, remote);
    } else {
      for (const { text } of readDir(dir, MESSAGES_DIR, () => true)) {
        const m = parseMessageFile(text);
        if (!m || knownMessage(db, project.id, m.id)) continue;
        if (storeIncomingMessage(db, project.id, m)) {
          s.messagesReceived++;
          applyMessage(db, m, project.id);
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

/**
 * Box: change the signing key and re-sign everything already on each of its inboxes with the new one, so
 * clients that switch to the new key still see the whole history. A file is re-signed only if it was valid
 * under the old key (or already under the new one), so a forged file is never made to look genuine; with no
 * old key at all (unsigned mode) every well-formed file is signed. Returns one summary per box project.
 * Run it only on the box: it is the one place that holds both keys.
 */
export function rotateKey(db: Database, oldKey: string | null, newKey: string): Array<{ project: string; resigned?: number; error?: string }> {
  const out: Array<{ project: string; resigned?: number; error?: string }> = [];
  for (const r of listRemotes(db)) {
    if (r.role !== 'box') continue;
    const project = getProjectById(db, r.project_id);
    if (!project) continue;
    try {
      const resigned = rewriteInbox(inboxDir(project.name), r.url, (text) => {
        let o: any;
        try {
          o = JSON.parse(text);
        } catch {
          return null;
        }
        if (!o || typeof o !== 'object' || o.v !== 1) return null;
        if (signatureOk(o, newKey)) return null; // already done (an earlier, interrupted rotation)
        if (oldKey && !signatureOk(o, oldKey)) return null; // not ours: leave it, clients ignore it
        const { sig: _sig, ...bare } = o;
        return JSON.stringify(signFile(bare, newKey), null, 2) + '\n';
      });
      out.push({ project: project.name, resigned });
    } catch (e: any) {
      out.push({ project: project.name, error: String(e?.message ?? e) });
    }
  }
  return out;
}
