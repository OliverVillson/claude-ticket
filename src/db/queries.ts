import type { Database } from 'bun:sqlite';
import type { Project, Run, RunOutcome, Ticket, TicketStatus, TicketView } from './types.ts';
import { CliError } from '../core/errors.ts';
import { appendFileSync } from 'node:fs';
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
  concurrency?: number | null;
}

export function createProject(db: Database, p: NewProject): Project {
  const count = db.query<{ c: number }, []>('SELECT COUNT(*) AS c FROM projects').get()!.c;
  const isDefault = p.isDefault || count === 0 ? 1 : 0;
  const tx = db.transaction(() => {
    if (isDefault) db.run('UPDATE projects SET is_default = 0');
    db.run(
      `INSERT INTO projects (name, path, is_default, default_model, default_effort, concurrency, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [p.name, p.path, isDefault, p.defaultModel ?? null, p.defaultEffort ?? null, p.concurrency ?? null, now()],
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
  patch: Partial<Pick<Project, 'name' | 'path' | 'default_model' | 'default_effort' | 'concurrency'>>,
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

export function deleteProject(db: Database, id: number) {
  const p = getProjectById(db, id);
  db.run('DELETE FROM projects WHERE id = ?', [id]);
  if (p?.is_default) {
    const next = db.query<Project, []>('SELECT * FROM projects ORDER BY created_at ASC LIMIT 1').get();
    if (next) setDefaultProject(db, next.id);
  }
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
}

const TICKET_VIEW_SQL = `
  SELECT t.*, p.name AS project, p.path AS project_path
  FROM tickets t JOIN projects p ON p.id = t.project_id`;

export function createTicket(db: Database, t: NewTicket): TicketView {
  const ts = now();
  try {
    db.run(
      `INSERT INTO tickets (project_id, name, query, tags, labels, priority, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'todo', ?, ?)`,
      [
        t.project_id,
        t.name,
        t.query,
        JSON.stringify(t.tags ?? {}),
        JSON.stringify(t.labels ?? []),
        t.priority ?? 3,
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
  status?: TicketStatus | TicketStatus[];
}

export function listTickets(db: Database, f: ListFilter = {}): TicketView[] {
  const where: string[] = [];
  const vals: any[] = [];
  if (f.projectId != null) {
    where.push('t.project_id = ?');
    vals.push(f.projectId);
  }
  if (f.status) {
    const s = Array.isArray(f.status) ? f.status : [f.status];
    where.push(`t.status IN (${s.map(() => '?').join(',')})`);
    vals.push(...s);
  }
  const sql = `${TICKET_VIEW_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY CASE t.status WHEN 'running' THEN 0 WHEN 'paused' THEN 1 WHEN 'todo' THEN 2 WHEN 'blocked' THEN 3 WHEN 'failed' THEN 4 ELSE 5 END,
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

export function countTickets(db: Database, projectId?: number): Record<TicketStatus, number> {
  const rows = projectId
    ? db.query<{ status: TicketStatus; c: number }, [number]>('SELECT status, COUNT(*) AS c FROM tickets WHERE project_id = ? GROUP BY status').all(projectId)
    : db.query<{ status: TicketStatus; c: number }, []>('SELECT status, COUNT(*) AS c FROM tickets GROUP BY status').all();
  const out: Record<TicketStatus, number> = { todo: 0, running: 0, done: 0, failed: 0, blocked: 0, paused: 0 };
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
    WHERE t.status IN ('paused', 'todo') ${where.length ? 'AND ' + where.join(' AND ') : ''}
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
        `UPDATE tickets SET status = 'running', attempts = attempts + 1, started_at = COALESCE(started_at, ?), finished_at = NULL, error = NULL, updated_at = ? WHERE id = ? AND status IN ('paused','todo')`,
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
  return p?.default_model ?? null;
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
