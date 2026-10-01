import { Database } from 'bun:sqlite';
import { dbPath, ensureHome } from '../core/paths.ts';
import { ensureThreadTables } from '../threads/store.ts';

const SCHEMA_VERSION = 9;

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

/**
 * Git sync tables. Idempotent and not tied to a schema version, so the numbering of migrations that
 * other changes add at the same time cannot skip them.
 */
function ensureSyncTables(db: Database) {
  // Git sync transport: a project's remote, the tickets that cross it, and the orchestrator's messages.
    db.exec(`
      CREATE TABLE IF NOT EXISTS remotes (
        project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'client',
        name TEXT NOT NULL DEFAULT '',
        last_sync INTEGER,
        last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS remote_tickets (
        uuid TEXT PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
        direction TEXT NOT NULL,
        sent INTEGER NOT NULL DEFAULT 0,
        queue INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS remote_tickets_ticket ON remote_tickets(ticket_id);
      CREATE TABLE IF NOT EXISTS remote_replies (
        id TEXT PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        direction TEXT NOT NULL,
        ref TEXT,
        name TEXT,
        body TEXT NOT NULL,
        now INTEGER NOT NULL DEFAULT 0,
        at INTEGER NOT NULL,
        sent INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS remote_actions (
        id TEXT PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        direction TEXT NOT NULL,
        ref TEXT,
        name TEXT,
        action TEXT NOT NULL,
        at INTEGER NOT NULL,
        sent INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS remote_messages (
        id TEXT NOT NULL,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        at INTEGER NOT NULL,
        body TEXT NOT NULL,
        direction TEXT NOT NULL,
        posted INTEGER NOT NULL DEFAULT 0,
        read_at INTEGER,
        PRIMARY KEY (project_id, id)
      );
    `);
  // A reply can answer one of the worker's decisions (JSON {id, option?}); added after the table first shipped.
  if (!db.query<{ name: string }, []>('PRAGMA table_info(remote_replies)').all().some((c) => c.name === 'decision')) db.exec('ALTER TABLE remote_replies ADD COLUMN decision TEXT;');
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
    // What a finished ticket leaves behind: the worker's short final report and the branch it committed on.
    db.exec('ALTER TABLE tickets ADD COLUMN summary TEXT;');
    db.exec('ALTER TABLE tickets ADD COLUMN branch TEXT;');
  }
  if (version < 8) {
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
  ensureSyncTables(db);
  // v9: checklist, decisions, outputs and sub-thread links. Idempotent, so it also covers a v9 database from the core's migration.
  ensureThreadTables(db);
  if (version < SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
}

export function closeDb() {
  cached?.close();
  cached = null;
}
