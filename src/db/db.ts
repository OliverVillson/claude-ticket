import { Database } from 'bun:sqlite';
import { dbPath, ensureHome } from '../core/paths.ts';

const SCHEMA_VERSION = 6;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  default_model TEXT,
  default_effort TEXT,
  concurrency INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  query TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '{}',
  labels TEXT NOT NULL DEFAULT '[]',
  priority INTEGER NOT NULL DEFAULT 3,
  status TEXT NOT NULL DEFAULT 'todo',
  attempts INTEGER NOT NULL DEFAULT 0,
  session_id TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  error TEXT,
  depends_on TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  UNIQUE(project_id, name)
);
CREATE INDEX IF NOT EXISTS tickets_dispatch ON tickets(status, priority, created_at);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  outcome TEXT,
  turns INTEGER,
  cost_usd REAL,
  log_path TEXT
);
CREATE INDEX IF NOT EXISTS runs_ticket ON runs(ticket_id, started_at);
CREATE TABLE IF NOT EXISTS state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

let cached: Database | null = null;

/** Open (and migrate) the ticket database. Cached per process. */
export function openDb(path?: string): Database {
  if (cached && !path) return cached;
  if (!path) ensureHome();
  const db = new Database(path ?? dbPath(), { create: true });
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 2000;');
  migrate(db);
  if (!path) cached = db;
  return db;
}

function migrate(db: Database) {
  const row = db.query<{ user_version: number }, []>('PRAGMA user_version;').get();
  const version = row?.user_version ?? 0;
  if (version < 1) {
    db.exec(SCHEMA);
  }
  if (version < 2) {
    // Subprojects: existing projects stay top level (parent_id NULL). Deleting a parent deletes its subtree.
    db.exec('ALTER TABLE projects ADD COLUMN parent_id INTEGER REFERENCES projects(id) ON DELETE CASCADE;');
    db.exec('CREATE INDEX IF NOT EXISTS projects_parent ON projects(parent_id);');
  }
  if (version < 3) {
    db.exec('ALTER TABLE projects ADD COLUMN default_tools TEXT;');
  }
  if (version < 4) {
    // Tool uses the worker was refused (JSON array), so a blocked ticket can say what permission it needs.
    db.exec('ALTER TABLE tickets ADD COLUMN denied TEXT;');
  }
  if (version < 5) {
    // Opt-in kernel sandbox per project (0 = off, 1 = on).
    db.exec('ALTER TABLE projects ADD COLUMN sandbox INTEGER NOT NULL DEFAULT 0;');
  }
  if (version < 6) {
    // The conversation on a ticket after its first prompt: your follow-ups and the worker's replies.
    db.exec(`CREATE TABLE IF NOT EXISTS turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      body TEXT NOT NULL,
      delivered INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );`);
    db.exec('CREATE INDEX IF NOT EXISTS turns_ticket ON turns(ticket_id, id);');
  }
  if (version < SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
}

export function closeDb() {
  cached?.close();
  cached = null;
}
