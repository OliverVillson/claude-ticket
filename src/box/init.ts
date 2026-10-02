import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runnerRoot } from '../core/runner.ts';
import { CliError } from '../core/errors.ts';

/**
 * `salu box init`: the keys a box needs to talk to a Mac over the control repo (docs/control-channel.md). Run once by
 * the installer as root (the folder is root's, so agents never read these keys); running it again changes nothing and prints the same answer, so an installer that
 * was cut off by an ssh drop can simply be started again.
 */

export const BOX_NAME = /^[a-z0-9-]{1,32}$/;

export const boxDir = (env: NodeJS.ProcessEnv = process.env) => env.SALU_BOX_DIR || join(runnerRoot(env), 'box');

/** The host name, made into a legal box name. */
export function defaultBoxName(host = hostname()): string {
  return host.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '') || 'salubox';
}

export interface BoxInit {
  box: string;
  deployPub: string;
  sealPub: string;
  boxKey: string;
  version: string;
}

/** Write a file with its final content and mode in one step, so an interrupted run never leaves half a key. */
function put(path: string, body: string): void {
  const tmp = `${path}.tmp${process.pid}`;
  writeFileSync(tmp, body, { mode: 0o600 });
  renameSync(tmp, path);
}

const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8').trim() : '');

export function boxInit(o: { name?: string; dir?: string; version: string }): BoxInit {
  const dir = o.dir ?? boxDir();
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  } catch (e: any) {
    throw new CliError(`could not create ${dir}: ${e.message} (run it as root: sudo salu box init)`);
  }
  const named = o.name ?? (read(join(dir, 'name')) || defaultBoxName());
  if (!BOX_NAME.test(named)) throw new CliError(`the box name "${named}" is not allowed: use 1 to 32 characters of a-z, 0-9 and -`);
  const existing = read(join(dir, 'name'));
  if (existing && existing !== named && o.name) throw new CliError(`this box is already named "${existing}"; its keys belong to that name`);

  // deploy: ed25519 ssh key, the write deploy key of the control repo
  if (!existsSync(join(dir, 'deploy')) || !existsSync(join(dir, 'deploy.pub'))) {
    const tmp = mkdtempSync(join(dir, '.keygen-'));
    try {
      const r = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `salu-box-${named}`, '-f', join(tmp, 'k')], { encoding: 'utf8' });
      if (r.status !== 0) throw new CliError(`ssh-keygen failed: ${(r.stderr || r.error?.message || '').trim()} (install openssh-client)`);
      renameSync(join(tmp, 'k.pub'), join(dir, 'deploy.pub'));
      renameSync(join(tmp, 'k'), join(dir, 'deploy')); // the private half last: its presence means the pair is complete
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  // seal: X25519, raw 32 byte halves (base64); the private half never leaves the box
  if (!existsSync(join(dir, 'seal.key')) || !existsSync(join(dir, 'seal.pub'))) {
    const { publicKey, privateKey } = generateKeyPairSync('x25519');
    const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
    const priv = Buffer.from(privateKey.export({ format: 'jwk' }).d!, 'base64url');
    put(join(dir, 'seal.pub'), pub.toString('base64') + '\n');
    put(join(dir, 'seal.key'), priv.toString('base64') + '\n');
  }
  // box: HMAC-SHA256 secret that signs replies and the heartbeat
  if (!existsSync(join(dir, 'box.key'))) put(join(dir, 'box.key'), randomBytes(32).toString('base64') + '\n');
  put(join(dir, 'name'), named + '\n');
  for (const f of ['deploy', 'seal.key', 'box.key']) chmodSync(join(dir, f), 0o600);

  return { box: named, deployPub: read(join(dir, 'deploy.pub')), sealPub: read(join(dir, 'seal.pub')), boxKey: read(join(dir, 'box.key')), version: o.version };
}
