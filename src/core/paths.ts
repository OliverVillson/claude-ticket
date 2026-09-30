import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import '../core/compat.ts';

/** Root folder for the database, logs and orchestrator state. Override with SALU_HOME. */
export function ticketHome(): string {
  return process.env.SALU_HOME || join(homedir(), '.salu');
}

/** One-time move of the old ~/.ticket data folder to ~/.salu (only when SALU_HOME is not set). */
function migrateLegacyHome(): void {
  if (process.env.SALU_HOME) return;
  const old = join(homedir(), '.ticket');
  const next = join(homedir(), '.salu');
  if (existsSync(old) && !existsSync(next)) {
    try {
      renameSync(old, next);
    } catch {
      /* leave it; a fresh ~/.salu is created below */
    }
  }
}

export function dbPath(): string {
  return join(ticketHome(), 'tickets.db');
}

export function logsDir(): string {
  return join(ticketHome(), 'logs');
}

/** File the CLI touches to wake the orchestrator immediately after a change. */
export function wakeFile(): string {
  return join(ticketHome(), 'wake');
}

export function orchestratorLogPath(): string {
  return join(ticketHome(), 'orchestrator.log');
}

export function ensureHome(): string {
  migrateLegacyHome();
  const home = ticketHome();
  mkdirSync(home, { recursive: true });
  return home;
}
