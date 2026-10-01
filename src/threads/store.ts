/**
 * What a thread (ticket) carries beyond its conversation: the live checklist, decisions the worker
 * asked, outputs it attached, and the sub-threads it started. Schema v9; see
 * /mnt/project-files/salu-threads/worker-tool.md for the contract.
 */
import type { Database } from 'bun:sqlite';

export type ChecklistState = 'todo' | 'doing' | 'done';
export interface ChecklistItem {
  text: string;
  state: ChecklistState;
}

export interface DecisionOption {
  label: string;
  consequence: string;
}

export interface Decision {
  id: number;
  ticket_id: number;
  question: string;
  context: string;
  options: DecisionOption[];
  recommended: number; // 0-based
  status: 'open' | 'answered';
  chosen: number | null; // 0-based; null when answered with typed words
  answer_text: string | null;
  created_at: number;
  answered_at: number | null;
}

export type OutputKind = 'branch' | 'pr' | 'file' | 'link';
export const OUTPUT_KINDS: OutputKind[] = ['branch', 'pr', 'file', 'link'];

export interface Output {
  id: number;
  ticket_id: number;
  kind: OutputKind;
  ref: string;
  title: string;
  created_at: number;
}

export interface ChildThread {
  id: number;
  name: string;
  status: string;
}

export interface ThreadSummary {
  checklist: ChecklistItem[];
  decisions: Decision[];
  outputs: Output[];
  parent: ChildThread | null;
  children: ChildThread[];
}

const now = () => Date.now();

/** Create the v9 tables and column. Idempotent, so it does not depend on which other migrations ran. */
export function ensureThreadTables(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS thread_status (
      ticket_id INTEGER PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
      items TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      question TEXT NOT NULL,
      context TEXT NOT NULL DEFAULT '',
      options TEXT NOT NULL,
      recommended INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'open',
      chosen INTEGER,
      answer_text TEXT,
      created_at INTEGER NOT NULL,
      answered_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS decisions_ticket ON decisions(ticket_id, id);
    CREATE TABLE IF NOT EXISTS outputs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      ref TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      UNIQUE (ticket_id, kind, ref)
    );
  `);
  const cols = db.query<{ name: string }, []>('PRAGMA table_info(tickets)').all();
  if (!cols.some((c) => c.name === 'parent_id')) {
    db.exec('ALTER TABLE tickets ADD COLUMN parent_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL;');
  }
  db.exec('CREATE INDEX IF NOT EXISTS tickets_parent ON tickets(parent_id);');
}

// ---- checklist ----------------------------------------------------------------------------------

export function getChecklist(db: Database, ticketId: number): ChecklistItem[] {
  const row = db.query<{ items: string }, [number]>('SELECT items FROM thread_status WHERE ticket_id = ?').get(ticketId);
  if (!row) return [];
  try {
    const v = JSON.parse(row.items);
    return Array.isArray(v) ? v.filter((x) => x && typeof x.text === 'string') : [];
  } catch {
    return [];
  }
}

export function setChecklist(db: Database, ticketId: number, items: ChecklistItem[]): void {
  db.run('INSERT INTO thread_status (ticket_id, items, updated_at) VALUES (?, ?, ?) ON CONFLICT(ticket_id) DO UPDATE SET items = excluded.items, updated_at = excluded.updated_at', [ticketId, JSON.stringify(items), now()]);
}

export function clearChecklist(db: Database, ticketId: number): void {
  db.run('DELETE FROM thread_status WHERE ticket_id = ?', [ticketId]);
}

// ---- decisions ----------------------------------------------------------------------------------

type DecisionRow = Omit<Decision, 'options'> & { options: string };

function toDecision(r: DecisionRow): Decision {
  let options: DecisionOption[] = [];
  try {
    const v = JSON.parse(r.options);
    if (Array.isArray(v)) options = v;
  } catch {
    /* keep empty */
  }
  return { ...r, options };
}

export function addDecision(db: Database, ticketId: number, d: { question: string; context?: string; options: DecisionOption[]; recommended: number }): Decision {
  db.run('INSERT INTO decisions (ticket_id, question, context, options, recommended, created_at) VALUES (?, ?, ?, ?, ?, ?)', [ticketId, d.question, d.context ?? '', JSON.stringify(d.options), d.recommended, now()]);
  const id = db.query<{ id: number }, []>('SELECT last_insert_rowid() AS id').get()!.id;
  return getDecision(db, id)!;
}

export function getDecision(db: Database, id: number): Decision | null {
  const r = db.query<DecisionRow, [number]>('SELECT * FROM decisions WHERE id = ?').get(id);
  return r ? toDecision(r) : null;
}

export function listDecisions(db: Database, ticketId: number, o: { open?: boolean } = {}): Decision[] {
  const rows = db.query<DecisionRow, [number]>(`SELECT * FROM decisions WHERE ticket_id = ? ${o.open ? "AND status = 'open'" : ''} ORDER BY id`).all(ticketId);
  return rows.map(toDecision);
}

/** Mark a decision answered: with the chosen option (0-based), with typed words, or both. */
export function answerDecision(db: Database, id: number, a: { chosen?: number | null; text?: string | null }): Decision {
  db.run("UPDATE decisions SET status = 'answered', chosen = ?, answer_text = ?, answered_at = ? WHERE id = ?", [a.chosen ?? null, a.text ?? null, now(), id]);
  return getDecision(db, id)!;
}

// ---- outputs ------------------------------------------------------------------------------------

export function addOutput(db: Database, ticketId: number, o: { kind: OutputKind; ref: string; title?: string }): Output {
  db.run('INSERT INTO outputs (ticket_id, kind, ref, title, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(ticket_id, kind, ref) DO UPDATE SET title = excluded.title WHERE excluded.title != \'\'', [ticketId, o.kind, o.ref, o.title ?? '', now()]);
  return db.query<Output, [number, string, string]>('SELECT * FROM outputs WHERE ticket_id = ? AND kind = ? AND ref = ?').get(ticketId, o.kind, o.ref)!;
}

export function listOutputs(db: Database, ticketId: number): Output[] {
  return db.query<Output, [number]>('SELECT * FROM outputs WHERE ticket_id = ? ORDER BY id').all(ticketId);
}

// ---- sub-threads --------------------------------------------------------------------------------

export function listChildren(db: Database, ticketId: number): ChildThread[] {
  return db.query<ChildThread, [number]>('SELECT id, name, status FROM tickets WHERE parent_id = ? ORDER BY id').all(ticketId);
}

export function getParent(db: Database, ticketId: number): ChildThread | null {
  return db.query<ChildThread, [number]>('SELECT p.id, p.name, p.status FROM tickets t JOIN tickets p ON p.id = t.parent_id WHERE t.id = ?').get(ticketId) ?? null;
}

/** Depth of a ticket in its parent chain: 0 for a top-level ticket. */
export function threadDepth(db: Database, ticketId: number): number {
  let d = 0;
  let cur = db.query<{ parent_id: number | null }, [number]>('SELECT parent_id FROM tickets WHERE id = ?').get(ticketId)?.parent_id ?? null;
  while (cur != null && d < 50) {
    d++;
    cur = db.query<{ parent_id: number | null }, [number]>('SELECT parent_id FROM tickets WHERE id = ?').get(cur)?.parent_id ?? null;
  }
  return d;
}

/** Everything a thread view needs in one call. */
export function threadSummary(db: Database, ticketId: number): ThreadSummary {
  return {
    checklist: getChecklist(db, ticketId),
    decisions: listDecisions(db, ticketId),
    outputs: listOutputs(db, ticketId),
    parent: getParent(db, ticketId),
    children: listChildren(db, ticketId),
  };
}
