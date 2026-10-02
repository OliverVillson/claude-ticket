import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ticketHome } from '../core/paths.ts';
import { CliError } from '../core/errors.ts';

/**
 * What the Mac knows about one box: ~/.salu/boxes/<box>.json (0600). It doubles as the resume
 * state of `salu box add`: a step that has its field filled in is not done again.
 * The control module (src/control/client.ts) reads `box`, `sealPub`, `macKey` and `boxKey` from it.
 */
export interface BoxConfig {
  box: string;
  /** user@host that pairing used; kept for `salu box update` fallbacks and messages. */
  host: string;
  /** Pairing progress, in order. */
  installed?: boolean;
  deployPub?: string;
  /** base64 X25519 public key of the box (the Mac seals secrets to it). */
  sealPub?: string;
  /** base64, signs replies and heartbeat; the Mac checks them with it. */
  boxKey?: string;
  version?: string;
  /** Control repo, ssh form (the box uses it) and https form (this Mac uses it). */
  repoSsh?: string;
  repoHttps?: string;
  keyAdded?: boolean;
  /** base64, 32 bytes, made on the Mac. Signs commands. */
  macKey?: string;
  connected?: boolean;
  loggedIn?: boolean;
  paired?: boolean;
}

export const BOX_NAME_RE = /^[a-z0-9-]{1,32}$/;

export function boxesDir(): string {
  return join(ticketHome(), 'boxes');
}

const file = (box: string) => join(boxesDir(), `${box}.json`);

export function loadBox(box: string): BoxConfig | null {
  try {
    const p = file(box);
    return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as BoxConfig) : null;
  } catch {
    return null;
  }
}

export function saveBox(cfg: BoxConfig): void {
  mkdirSync(boxesDir(), { recursive: true, mode: 0o700 });
  const p = file(cfg.box);
  writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  chmodSync(p, 0o600);
}

export function removeBoxFile(box: string): void {
  rmSync(file(box), { force: true });
}

export function listBoxes(): BoxConfig[] {
  try {
    return readdirSync(boxesDir())
      .filter((f) => f.endsWith('.json'))
      .map((f) => loadBox(f.slice(0, -5)))
      .filter((b): b is BoxConfig => !!b)
      .sort((a, b) => a.box.localeCompare(b.box));
  } catch {
    return [];
  }
}

/** Only paired boxes count when picking one automatically. */
export function pickBox(name?: string): BoxConfig {
  if (name) {
    const b = loadBox(name);
    if (!b) throw new CliError(`no box called "${name}" on this computer. Pair it first: salu box add user@host`);
    return b;
  }
  const paired = listBoxes().filter((b) => b.paired);
  if (paired.length === 1) return paired[0]!;
  if (!paired.length) throw new CliError('no box is paired yet. Start with: salu box add user@host');
  throw new CliError(`more than one box is paired (${paired.map((b) => b.box).join(', ')}). Say which: --box <name>`);
}

/** Per-project resume state of `salu new`: ~/.salu/new/<name>.json (0600). Holds the project's deploy key. */
export interface NewState {
  name: string;
  box: string;
  repo?: string; // owner/name
  repoSsh?: string;
  repoHttps?: string;
  deployPriv?: string;
  deployPub?: string;
  keyAdded?: boolean;
  created?: boolean; // the box answered project.create ok
}

const newFile = (name: string) => join(ticketHome(), 'new', `${name}.json`);

export function loadNew(name: string): NewState | null {
  try {
    const p = newFile(name);
    return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as NewState) : null;
  } catch {
    return null;
  }
}

export function saveNew(s: NewState): void {
  mkdirSync(join(ticketHome(), 'new'), { recursive: true, mode: 0o700 });
  const p = newFile(s.name);
  writeFileSync(p, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
  chmodSync(p, 0o600);
}

export function clearNew(name: string): void {
  rmSync(newFile(name), { force: true });
}
