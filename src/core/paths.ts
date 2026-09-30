import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

/** Root folder for the database, logs and orchestrator state. Override with TICKET_HOME. */
export function ticketHome(): string {
  return process.env.TICKET_HOME || join(homedir(), '.ticket');
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
  const home = ticketHome();
  mkdirSync(home, { recursive: true });
  return home;
}
