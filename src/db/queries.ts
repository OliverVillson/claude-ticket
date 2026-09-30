import type { Database } from 'bun:sqlite';
import type { Project, ProjectNode, Run, RunOutcome, Ticket, TicketStatus, TicketView, Turn } from './types.ts';
import { CliError } from '../core/errors.ts';
import { appendFileSync } from 'node:fs';
import { DEFAULT_MODEL } from '../core/tags.ts';
import { wakeFile } from '../core/paths.ts';

export const now = () => Date.now();

/** Touch the wake file so a running orchestrator dispatches immediately. Cheap and safe to call often. */
export function wakeOrchestrator() {
  try {
    // Append a byte: fs.watch in Bun does not fire on mtime-only changes.
    appendFileSync(wakeFile(), '.');
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export interface NewProject {
  name: string;
  path: string;
  isDefault?: boolean;
  defaultModel?: string | null;
  defaultEffort?: string | null;
  defaultTools?: string | null;
  sandbox?: boolean;
  concurrency?: number | null;
  parentId?: number | null;
}

export function createProject(db: Database, p: NewProject): Project {
  if (p.parentId != null && !getProjectById(db, p.parentId)) throw new CliError(`no project with id ${p.parentId} to put "${p.name}" in`);
  const count = db.query<{ c: number }, []>('SELECT COUNT(*) AS c FROM projects').get()!.c;
  const isDefault = p.isDefault || count === 0 ? 1 : 0;
  const tx = db.transaction(() => {
    if (isDefault) db.run('UPDATE projects SET is_default = 0');
    db.run(
      `INSERT INTO projects (name, path, is_default, default_model, default_effort, default_tools, concurrency, created_at, parent_id, sandbox)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [p.name, p.path, isDefault, p.defaultModel ?? null, p.defaultEffort ?? null, p.defaultTools ?? null, p.concurrency ?? null, now(), p.parentId ?? null, p.sandbox ? 1 : 0],
    );
  });
  try {
    tx();
  } catch (e: any) {
    if (String(e?.message).includes('UNIQUE')) throw new CliError(`project "${p.name}" already exists`);
    throw e;
  }
  return getProjectByName(db, p.name)!;
}

export function getProjectByName(db: Database, name: string): Project | null {
  return db.query<Project, [string]>('SELECT * FROM projects WHERE name = ?').get(name);
}

export function getProjectById(db: Database, id: number): Project | null {
  return db.query<Project, [number]>('SELECT * FROM projects WHERE id = ?').get(id);
}

export function listProjects(db: Database): Project[] {
  return db.query<Project, []>('SELECT * FROM projects ORDER BY is_default DESC, name ASC').all();
}

export function getDefaultProject(db: Database): Project | null {
  return db.query<Project, []>('SELECT * FROM projects WHERE is_default = 1 LIMIT 1').get();
}

export function setDefaultProject(db: Database, id: number) {
  const tx = db.transaction(() => {
    db.run('UPDATE projects SET is_default = 0');
    db.run('UPDATE projects SET is_default = 1 WHERE id = ?', [id]);
  });
  tx();
}

export function updateProject(
  db: Database,
  id: number,
  patch: Partial<Pick<Project, 'name' | 'path' | 'default_model' | 'default_effort' | 'default_tools' | 'concurrency' | 'sandbox'>>,
) {
  const sets: string[] = [];
  const vals: any[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  if (!sets.length) return;
  vals.push(id);
  db.run(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`, vals);
}

/** Deletes the project, all its descendants and every ticket in them. */
export function deleteProject(db: Database, id: number) {
  const p = getProjectById(db, id);
  db.run('DELETE FROM projects WHERE id = ?', [id]); // children and tickets go with it (ON DELETE CASCADE)
  if (p?.is_default) {
    const next = db.query<Project, []>('SELECT * FROM projects ORDER BY created_at ASC LIMIT 1').get();
    if (next) setDefaultProject(db, next.id);
  }
}

/** The id of `id` plus the ids of every descendant, parents before children. */
export function subtreeIds(db: Database, id: number): number[] {
  return db
    .query<{ id: number }, [number]>(
      `WITH RECURSIVE sub(id) AS (SELECT id FROM projects WHERE id = ? UNION ALL SELECT p.id FROM projects p JOIN sub ON p.parent_id = sub.id) SELECT id FROM sub`,
    )
    .all(id)
    .map((r) => r.id);
}

export function getChildren(db: Database, parentId: number | null): Project[] {
  return parentId == null
    ? db.query<Project, []>('SELECT * FROM projects WHERE parent_id IS NULL ORDER BY is_default DESC, name ASC').all()
    : db.query<Project, [number]>('SELECT * FROM projects WHERE parent_id = ? ORDER BY name ASC').all(parentId);
}

/** Names from the top-level project down to `id`: `parent/sub/leaf`. */
export function projectQualifiedName(db: Database, id: number): string {
  const names: string[] = [];
  for (let p = getProjectById(db, id), guard = 0; p && guard < 64; p = p.parent_id == null ? null : getProjectById(db, p.parent_id), guard++) names.unshift(p.name);
  return names.join('/');
}

/** Every project as a tree (roots first), with ticket counts for each node alone and for its whole subtree. */
export function listProjectTree(db: Database): ProjectNode[] {
  const all = db.query<Project, []>('SELECT * FROM projects ORDER BY is_default DESC, name ASC').all();
  const rows = db.query<{ project_id: number; status: TicketStatus; c: number }, []>('SELECT project_id, status, COUNT(*) AS c FROM tickets GROUP BY project_id, status').all();
  const empty = (): Record<TicketStatus, number> => ({ backlog: 0, todo: 0, running: 0, done: 0, failed: 0, blocked: 0, paused: 0 });
  const nodes = new Map<number, ProjectNode>();
  for (const p of all) nodes.set(p.id, { ...p, depth: 0, children: [], counts: empty(), own: empty() });
  for (const r of rows) {
    const n = nodes.get(r.project_id);
    if (n) n.own[r.status] = r.c;
  }
  const roots: ProjectNode[] = [];
  for (const n of nodes.values()) {
    const parent = n.parent_id == null ? undefined : nodes.get(n.parent_id);
    (parent ? parent.children : roots).push(n);
  }
  const fill = (n: ProjectNode, depth: number) => {
    n.depth = depth;
    n.children.sort((a, b) => a.name.localeCompare(b.name));
    n.counts = { ...n.own };
    for (const c of n.children) {
      fill(c, depth + 1);
      for (const s of Object.keys(n.counts) as TicketStatus[]) n.counts[s] += c.counts[s];
    }
  };
  for (const r of roots) fill(r, 0);
  return roots;
}

/** The tree as rows in display order; a node's children are left out when `isExpanded(node)` is false. */
export function flattenProjectTree(nodes: ProjectNode[], isExpanded: (p: Project) => boolean = () => true): ProjectNode[] {
  const out: ProjectNode[] = [];
  const walk = (list: ProjectNode[]) => {
    for (const n of list) {
      out.push(n);
      if (n.children.length && isExpanded(n)) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/** Re-parent a project (null = top level). Folders are not moved. */
export function moveProject(db: Database, id: number, parentId: number | null): void {
  if (parentId != null) {
    if (!getProjectById(db, parentId)) throw new CliError(`no project with id ${parentId}`);
    if (subtreeIds(db, id).includes(parentId)) throw new CliError('a project cannot be moved into itself or one of its own subprojects');
  }
  db.run('UPDATE projects SET parent_id = ? WHERE id = ?', [parentId, id]);
}

/** The project with model, effort, tools and concurrency filled in from the nearest ancestor that sets them. */
export function inheritedProject(db: Database, p: Project): Project {
  const out = { ...p };
  for (let cur = p, guard = 0; cur.parent_id != null && guard < 64; guard++) {
    const parent = getProjectById(db, cur.parent_id);
    if (!parent) break;
    out.default_model ??= parent.default_model;
    out.default_effort ??= parent.default_effort;
    out.default_tools ??= parent.default_tools;
    out.concurrency ??= parent.concurrency;
    if (!out.sandbox && parent.sandbox) out.sandbox = 1;
    cur = parent;
  }
  return out;
}

/** The registered project whose folder contains `cwd` (longest path wins), else null. */
export function findProjectForCwd(db: Database, cwd: string): Project | null {
  const norm = (s: string) => s.replace(/\/+$/, '');
  const c = norm(cwd);
  let best: Project | null = null;
  for (const p of listProjects(db)) {
    const pp = norm(p.path);
    if (c === pp || c.startsWith(pp + '/')) {
      if (!best || pp.length > norm(best.path).length) best = p;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

export interface NewTicket {
  project_id: number;
  name: string;
  query: string;
  tags?: Record<string, string>;
  labels?: string[];
  priority?: number;
  /** `backlog` (default): saved, does not run until queued. `todo`: queued now. */
  status?: 'backlog' | 'todo';
}

const TICKET_VIEW_SQL = `
  SELECT t.*, p.name AS project, p.path AS project_path
  FROM tickets t JOIN projects p ON p.id = t.project_id`;

export function createTicket(db: Database, t: NewTicket): TicketView {
  const ts = now();
  try {
    db.run(
      `INSERT INTO tickets (project_id, name, query, tags, labels, priority, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        t.project_id,
        t.name,
        t.query,
        JSON.stringify(t.tags ?? {}),
        JSON.stringify(t.labels ?? []),
        t.priority ?? 3,
        t.status ?? 'backlog',
        ts,
        ts,
      ],
    );
  } catch (e: any) {
    if (String(e?.message).includes('UNIQUE')) throw new CliError(`ticket "${t.name}" already exists in this project`);
    throw e;
  }
  const id = db.query<{ id: number }, []>('SELECT last_insert_rowid() AS id').get()!.id;
  wakeOrchestrator();
  return getTicketById(db, id)!;
}

/**
 * Queue a ticket: it becomes eligible to run (`todo`). Works from backlog and from finished states
 * (done, failed, blocked: a re-queue, which also clears the error and the attempt count).
 * `now` also puts it at the front. A running ticket is left alone.
 */
export function queueTicket(db: Database, id: number, o: { now?: boolean } = {}): TicketView {
  const t = getTicketById(db, id);
  if (!t) throw new CliError(`no ticket with id ${id}`);
  if (t.status === 'running') throw new CliError(`"${t.name}" is already running`);
  if (t.status === 'todo' && !o.now) return t;
  const patch: Parameters<typeof updateTicket>[2] = { status: 'todo', attempts: 0, error: null, denied: null, finished_at: null };
  if (o.now) patch.priority = 0;
  const out = updateTicket(db, id, patch);
  wakeOrchestrator();
  return out;
}

/** Take a queued ticket back to the backlog. Anything else (running, paused, finished) is refused. */
export function unqueueTicket(db: Database, id: number): TicketView {
  const t = getTicketById(db, id);
  if (!t) throw new CliError(`no ticket with id ${id}`);
  if (t.status === 'backlog') return t;
  if (t.status !== 'todo') throw new CliError(`"${t.name}" is ${t.status}; only a queued ticket can go back to the backlog`);
  return updateTicket(db, id, { status: 'backlog' });
}

/** Queue every backlog ticket (optionally only in these projects). Returns how many. */
export function queueAll(db: Database, o: { projectIds?: number[] } = {}): number {
  const where = o.projectIds?.length ? ` AND project_id IN (${o.projectIds.map(() => '?').join(',')})` : '';
  const r = db.run(`UPDATE tickets SET status = 'todo', updated_at = ? WHERE status = 'backlog'${where}`, [now(), ...(o.projectIds ?? [])]);
  if (r.changes) wakeOrchestrator();
  return r.changes;
}

export function getTicketById(db: Database, id: number): TicketView | null {
  return db.query<TicketView, [number]>(`${TICKET_VIEW_SQL} WHERE t.id = ?`).get(id);
}

export function getTicket(db: Database, projectId: number, name: string): TicketView | null {
  return db
    .query<TicketView, [number, string]>(`${TICKET_VIEW_SQL} WHERE t.project_id = ? AND t.name = ?`)
    .get(projectId, name);
}

/** Every ticket with this name across projects (names are unique per project only). */
export function findTicketsByName(db: Database, name: string): TicketView[] {
  return db.query<TicketView, [string]>(`${TICKET_VIEW_SQL} WHERE t.name = ? ORDER BY t.id`).all(name);
}

export interface ListFilter {
  projectId?: number;
  /** With projectId: include every descendant project's tickets (default true). false = that project only. */
  recursive?: boolean;
  status?: TicketStatus | TicketStatus[];
}

export function listTickets(db: Database, f: ListFilter = {}): TicketView[] {
  const where: string[] = [];
  const vals: any[] = [];
  if (f.projectId != null) {
    const ids = f.recursive === false ? [f.projectId] : subtreeIds(db, f.projectId);
    where.push(`t.project_id IN (${ids.map(() => '?').join(',')})`);
    vals.push(...ids);
  }
  if (f.status) {
    const s = Array.isArray(f.status) ? f.status : [f.status];
    where.push(`t.status IN (${s.map(() => '?').join(',')})`);
    vals.push(...s);
  }
  const sql = `${TICKET_VIEW_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY CASE t.status WHEN 'running' THEN 0 WHEN 'paused' THEN 1 WHEN 'todo' THEN 2 WHEN 'backlog' THEN 3 WHEN 'blocked' THEN 4 WHEN 'failed' THEN 5 ELSE 6 END,
             t.priority ASC, t.created_at ASC`;
  return db.query<TicketView, any[]>(sql).all(...vals);
}

export type TicketPatch = Partial<
  Pick<
    Ticket,
    | 'name'
    | 'query'
    | 'tags'
    | 'labels'
    | 'priority'
    | 'status'
    | 'attempts'
    | 'session_id'
    | 'cost_usd'
    | 'error'
    | 'denied'
    | 'started_at'
    | 'finished_at'
    | 'project_id'
  >
>;

export function updateTicket(db: Database, id: number, patch: TicketPatch): TicketView {
  const sets: string[] = [];
  const vals: any[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  sets.push('updated_at = ?');
  vals.push(now());
  vals.push(id);
  try {
    db.run(`UPDATE tickets SET ${sets.join(', ')} WHERE id = ?`, vals);
  } catch (e: any) {
    if (String(e?.message).includes('UNIQUE')) throw new CliError(`a ticket named "${patch.name}" already exists in this project`);
    throw e;
  }
  wakeOrchestrator();
  return getTicketById(db, id)!;
}

export function deleteTicket(db: Database, id: number) {
  db.run('DELETE FROM tickets WHERE id = ?', [id]);
  wakeOrchestrator();
}

export function countTickets(db: Database, projectId?: number, recursive = true): Record<TicketStatus, number> {
  const ids = projectId ? (recursive ? subtreeIds(db, projectId) : [projectId]) : [];
  const rows = projectId
    ? db.query<{ status: TicketStatus; c: number }, number[]>(`SELECT status, COUNT(*) AS c FROM tickets WHERE project_id IN (${ids.map(() => '?').join(',')}) GROUP BY status`).all(...ids)
    : db.query<{ status: TicketStatus; c: number }, []>('SELECT status, COUNT(*) AS c FROM tickets GROUP BY status').all();
  const out: Record<TicketStatus, number> = { backlog: 0, todo: 0, running: 0, done: 0, failed: 0, blocked: 0, paused: 0 };
  for (const r of rows) out[r.status] = r.c;
  return out;
}

/**
 * Atomically claim the next dispatchable ticket: `paused` tickets first (they resume a saved
 * session), then `todo` by priority then age. Marks it `running` and bumps `attempts`.
 * `excludeModels` skips tickets whose effective model starts with one of the prefixes
 * (used while only the Opus limit is exhausted). Returns null when nothing is claimable.
 */
export function claimNextTicket(
  db: Database,
  opts: { projectIds?: number[]; excludeModels?: string[]; preferPaused?: boolean } = {},
): TicketView | null {
  const where: string[] = [];
  const vals: any[] = [];
  if (opts.projectIds?.length) {
    where.push(`t.project_id IN (${opts.projectIds.map(() => '?').join(',')})`);
    vals.push(...opts.projectIds);
  }
  const sql = `${TICKET_VIEW_SQL}
    WHERE t.status IN ('paused', 'todo')
      AND NOT EXISTS (SELECT 1 FROM remote_tickets r WHERE r.ticket_id = t.id AND r.direction = 'out') ${where.length ? 'AND ' + where.join(' AND ') : ''}
    ORDER BY CASE t.status WHEN 'paused' THEN 0 ELSE 1 END, t.priority ASC, t.created_at ASC`;
  const tx = db.transaction(() => {
    const candidates = db.query<TicketView, any[]>(sql).all(...vals);
    for (const c of candidates) {
      if (opts.excludeModels?.length) {
        const model = effectiveModel(db, c);
        if (model && opts.excludeModels.some((m) => model.toLowerCase().startsWith(m.toLowerCase()))) continue;
      }
      const ts = now();
      db.run(
        `UPDATE tickets SET status = 'running', attempts = attempts + 1, started_at = COALESCE(started_at, ?), finished_at = NULL, error = NULL, denied = NULL, updated_at = ? WHERE id = ? AND status IN ('paused','todo')`,
        [ts, ts, c.id],
      );
      return getTicketById(db, c.id);
    }
    return null;
  });
  return tx() ?? null;
}

/** Model a ticket will run with: its tag, else the project default, else null (Claude Code's default). */
export function effectiveModel(db: Database, t: TicketView): string | null {
  try {
    const tags = JSON.parse(t.tags || '{}');
    if (tags.model) return String(tags.model);
  } catch {
    /* ignore */
  }
  const p = getProjectById(db, t.project_id);
  return (p ? inheritedProject(db, p).default_model : null) ?? DEFAULT_MODEL;
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export function createRun(db: Database, ticketId: number, logPath: string | null): Run {
  db.run('INSERT INTO runs (ticket_id, started_at, log_path) VALUES (?, ?, ?)', [ticketId, now(), logPath]);
  const id = db.query<{ id: number }, []>('SELECT last_insert_rowid() AS id').get()!.id;
  return getRun(db, id)!;
}

export function getRun(db: Database, id: number): Run | null {
  return db.query<Run, [number]>('SELECT * FROM runs WHERE id = ?').get(id);
}

export function finishRun(
  db: Database,
  id: number,
  r: { outcome: RunOutcome; turns?: number | null; cost_usd?: number | null },
) {
  db.run('UPDATE runs SET ended_at = ?, outcome = ?, turns = ?, cost_usd = ? WHERE id = ?', [
    now(),
    r.outcome,
    r.turns ?? null,
    r.cost_usd ?? null,
    id,
  ]);
}

export function listRuns(db: Database, ticketId: number): Run[] {
  return db.query<Run, [number]>('SELECT * FROM runs WHERE ticket_id = ? ORDER BY started_at DESC').all(ticketId);
}

export function latestRun(db: Database, ticketId: number): Run | null {
  return db.query<Run, [number]>('SELECT * FROM runs WHERE ticket_id = ? ORDER BY started_at DESC LIMIT 1').get(ticketId);
}

// ---------------------------------------------------------------------------
// State (key/value)
// ---------------------------------------------------------------------------

export function getState(db: Database, key: string): string | null {
  return db.query<{ value: string }, [string]>('SELECT value FROM state WHERE key = ?').get(key)?.value ?? null;
}

export function setState(db: Database, key: string, value: string | number | null) {
  if (value === null) {
    db.run('DELETE FROM state WHERE key = ?', [key]);
    return;
  }
  db.run('INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [
    key,
    String(value),
  ]);
}

export function getAllState(db: Database): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of db.query<{ key: string; value: string }, []>('SELECT key, value FROM state').all()) out[r.key] = r.value;
  return out;
}

// -------------------------------------------------------------------------------------------------
// Turns: the conversation on a ticket after its first prompt
// -------------------------------------------------------------------------------------------------

export function listTurns(db: Database, ticketId: number): Turn[] {
  return db.query<Turn, [number]>('SELECT * FROM turns WHERE ticket_id = ? ORDER BY id').all(ticketId);
}

/** Follow-ups no worker has been given yet, oldest first. */
export function pendingFollowUps(db: Database, ticketId: number): Turn[] {
  return db.query<Turn, [number]>("SELECT * FROM turns WHERE ticket_id = ? AND role = 'user' AND delivered = 0 ORDER BY id").all(ticketId);
}

export function addTurn(db: Database, ticketId: number, role: Turn['role'], body: string, delivered = true): void {
  db.run('INSERT INTO turns (ticket_id, role, body, delivered, created_at) VALUES (?, ?, ?, ?, ?)', [ticketId, role, body, delivered ? 1 : 0, now()]);
}

export function markFollowUpsDelivered(db: Database, ticketId: number): void {
  db.run("UPDATE turns SET delivered = 1 WHERE ticket_id = ? AND role = 'user' AND delivered = 0", [ticketId]);
}

/**
 * Send a follow-up message on a ticket. A finished ticket (done, blocked, failed) is queued again and
 * resumes its session with the message, so the worker keeps everything it learned. On a running
 * ticket the message waits and becomes the next turn once the current one ends. A backlog ticket
 * has not had its first prompt yet, so there is nothing to follow up on.
 */
export function replyToTicket(db: Database, id: number, message: string, o: { now?: boolean } = {}): TicketView {
  const body = message.trim();
  if (!body) throw new CliError('the message is empty');
  const t = getTicketById(db, id);
  if (!t) throw new CliError(`no ticket with id ${id}`);
  if (t.status === 'backlog') throw new CliError(`"${t.name}" has not run yet: queue it (\`salu queue\`) or edit its query instead`);
  addTurn(db, id, 'user', body, false);
  if (t.status === 'done' || t.status === 'blocked' || t.status === 'failed') return queueTicket(db, id, { now: o.now });
  if (o.now && t.status === 'todo') return queueTicket(db, id, { now: true });
  wakeOrchestrator();
  return t;
}
