/** Where the box keeps its control-channel keys: /var/lib/salu/box (override SALU_BOX_DIR), mode 0600. */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { generateSealKeys } from './seal.ts';

export const boxDir = () => process.env.SALU_BOX_DIR || '/var/lib/salu/box';

export interface BoxState {
  box: string;
  url: string; // control repo (git@github.com:<user>/salu-control.git)
  macKey: Buffer;
  boxKey: Buffer;
  sealKey: Buffer; // private
  sealPub: Buffer;
  deployKey: string; // path of the ssh private key
}

function writeSecret(path: string, data: Buffer | string): void {
  writeFileSync(path, data, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Create the keys the box makes itself (seal pair, reply key). Idempotent: existing keys are kept. */
export function ensureBoxKeys(dir = boxDir()): { sealPub: Buffer; boxKey: Buffer } {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const seal = join(dir, 'seal.key');
  const pub = join(dir, 'seal.pub');
  if (!existsSync(seal) || !existsSync(pub)) {
    const k = generateSealKeys();
    writeSecret(seal, k.privateKey.toString('base64'));
    writeSecret(pub, k.publicKey.toString('base64'));
  }
  const bk = join(dir, 'box.key');
  if (!existsSync(bk)) writeSecret(bk, randomBytes(32).toString('base64'));
  return { sealPub: Buffer.from(readFileSync(pub, 'utf8').trim(), 'base64'), boxKey: Buffer.from(readFileSync(bk, 'utf8').trim(), 'base64') };
}

/** Store what the Mac sent at pairing: the control repo url and the Mac's signing key. */
export function saveConnection(url: string, box: string, macKey: Buffer, dir = boxDir()): void {
  if (macKey.length !== 32) throw new Error('the Mac key must be 32 bytes');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeSecret(join(dir, 'mac.key'), macKey.toString('base64'));
  writeSecret(join(dir, 'control.json'), JSON.stringify({ box, url }));
}

export function loadBoxState(dir = boxDir()): BoxState {
  const need = (f: string) => {
    const p = join(dir, f);
    if (!existsSync(p)) throw new Error(`${p} is missing. Pair this box from your Mac first (salu box add).`);
    return readFileSync(p, 'utf8').trim();
  };
  const c = JSON.parse(need('control.json'));
  const b64 = (f: string) => Buffer.from(need(f), 'base64');
  return { box: c.box, url: c.url, macKey: b64('mac.key'), boxKey: b64('box.key'), sealKey: b64('seal.key'), sealPub: b64('seal.pub'), deployKey: join(dir, 'deploy') };
}
