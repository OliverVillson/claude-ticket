import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CliError } from './errors.ts';
import { ticketHome } from './paths.ts';
import { folderSlug } from './resolve.ts';

/**
 * Seat logins: one Claude token per seat (one Team or Enterprise seat per person), held on the host.
 * A ticket that names a seat runs in a container of its own for that (project, seat) and reaches the model
 * only through that seat's login proxy, so one seat's token is never in reach of another seat's agents.
 * A seat that has no token refuses the ticket: it never falls back to another seat's login or the box login.
 */

/** A seat id from the registry: short, lowercase, safe in a file name, a container name and a socket path. */
export const SEAT_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function validSeatId(id: unknown): id is string {
  return typeof id === 'string' && SEAT_ID.test(id);
}

export function requireSeatId(id: string): string {
  if (!validSeatId(id)) throw new CliError(`"${id}" is not a seat id (lowercase letters, digits and dashes, up to 32)`);
  return id;
}

/** Next to the box login (kernel-token), so runner projects and the proxy see the same folder. */
export function seatsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.SALU_SEATS_DIR || join(dirname(env.SALU_KERNEL_TOKEN_FILE || join(ticketHome(), 'kernel-token')), 'seats');
}

export const seatTokenFile = (seat: string, env: NodeJS.ProcessEnv = process.env) => join(seatsDir(env), `${requireSeatId(seat)}.token`);

/** The seat's token, or '' when it has none (read on every call, so a re-login or a removal takes effect at once). */
export function readSeatToken(seat: string, env: NodeJS.ProcessEnv = process.env): string {
  try {
    return readFileSync(seatTokenFile(seat, env), 'utf8').trim();
  } catch {
    return '';
  }
}

/** A setup-token or API key: nothing a shell or env file could misread. */
function tokenOk(t: string): boolean {
  return t.length >= 8 && t.length <= 4096 && /^[A-Za-z0-9._~+\/=-]+$/.test(t);
}

export function saveSeatToken(seat: string, token: string, env: NodeJS.ProcessEnv = process.env): string {
  const t = token.trim();
  if (!tokenOk(t)) throw new CliError('that does not look like a Claude token: run `claude setup-token` and use the whole line it prints');
  const file = seatTokenFile(seat, env);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, t + '\n', { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  return file;
}

export function removeSeatToken(seat: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const file = seatTokenFile(seat, env);
  const had = existsSync(file);
  rmSync(file, { force: true });
  return had;
}

/** Seats that have a login saved here. */
export function seatsWithLogin(env: NodeJS.ProcessEnv = process.env): string[] {
  try {
    return readdirSync(seatsDir(env)).filter((f) => f.endsWith('.token')).map((f) => f.slice(0, -6)).filter(validSeatId).sort();
  } catch {
    return [];
  }
}

/** What the container's Claude Code logs in with for a seat: the token itself (env mode) or, through the proxy, only a placeholder. */
export function seatAuth(seat: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const t = readSeatToken(seat, env);
  if (!t) return {};
  return /^sk-ant-api/.test(t) ? { ANTHROPIC_API_KEY: t } : { CLAUDE_CODE_OAUTH_TOKEN: t };
}

export function requireSeatAuth(seat: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const auth = seatAuth(seat, env);
  if (!Object.keys(auth).length) throw new CliError(`seat "${seat}" has no login on this machine: run \`claude setup-token\` as that person and then \`salu kernel login --seat ${seat}\` (a ticket never borrows another seat's login)`);
  return auth;
}

/**
 * One name for a (project, seat) pair, used for the container and its socket folder. The hash keeps two pairs
 * that spell alike ("a-b"+seat "c" vs "a"+seat "b-c") apart, so a seat's container is never another project's.
 */
export function seatKey(project: string, seat: string): string {
  const h = createHash('sha256').update(`${project}\0${seat}`).digest('hex').slice(0, 10);
  return `${h}-${folderSlug(project).slice(0, 40)}-${seat}`;
}
