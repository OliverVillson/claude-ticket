import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify, type KeyObject } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CliError } from '../core/errors.ts';
import { RELEASE_PUBKEYS } from './key.ts';

/**
 * Release signing. A release carries SHA256SUMS (the hash of every file in it) and SHA256SUMS.sig (an ed25519 signature
 * over those bytes). The public key is compiled into salu, so a box that already runs salu can check what it downloads
 * (the installer script, the bundle) before it runs anything: someone who can edit a GitHub release cannot sign.
 */

export const SUMS = 'SHA256SUMS';
export const SIG = 'SHA256SUMS.sig';
/** Mixed into what is signed, so this signature cannot be reused for anything else. */
const DOMAIN = Buffer.from('salu-release-v1\n');
const PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI = Buffer.from('302a300506032b6570032100', 'hex');

const privateFromSeed = (seed: Buffer): KeyObject => createPrivateKey({ key: Buffer.concat([PKCS8, seed]), format: 'der', type: 'pkcs8' });
const publicFromRaw = (raw: Buffer): KeyObject => createPublicKey({ key: Buffer.concat([SPKI, raw]), format: 'der', type: 'spki' });

/** A new key pair: the private seed (keep secret) and the public key (goes in src/release/key.ts), both base64. */
export function generateReleaseKey(): { seed: string; pub: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    seed: Buffer.from(privateKey.export({ format: 'jwk' }).d!, 'base64url').toString('base64'),
    pub: Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url').toString('base64'),
  };
}

export function publicOfSeed(seed: string): string {
  const raw = createPublicKey(privateFromSeed(Buffer.from(seed.trim(), 'base64'))).export({ format: 'jwk' }).x!;
  return Buffer.from(raw, 'base64url').toString('base64');
}

export function signSums(sums: Buffer, seed: string): string {
  const key = Buffer.from(seed.trim(), 'base64');
  if (key.length !== 32) throw new CliError('the signing key must be 32 bytes (base64), as made by salu release keygen');
  return edSign(null, Buffer.concat([DOMAIN, sums]), privateFromSeed(key)).toString('base64');
}

export function sigOk(sums: Buffer, sig: string, pubs: string[]): boolean {
  const s = Buffer.from(sig.trim(), 'base64');
  if (s.length !== 64) return false;
  return pubs.some((p) => {
    const raw = Buffer.from(p, 'base64');
    return raw.length === 32 && edVerify(null, Buffer.concat([DOMAIN, sums]), publicFromRaw(raw), s);
  });
}

/** `sha256sum` format: "<hex>  <name>", names without a folder part. */
export function parseSums(text: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const g = /^([0-9a-f]{64}) [ *]([^/\\\0]+)$/.exec(line);
    if (!g || g[2] === '.' || g[2] === '..') throw new CliError(`${SUMS} has a line that is not "<sha256>  <file name>": ${line.slice(0, 80)}`);
    if (m.has(g[2]!)) throw new CliError(`${SUMS} lists ${g[2]} twice`);
    m.set(g[2]!, g[1]!);
  }
  return m;
}

const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

export interface VerifyResult {
  ok: boolean;
  /** one plain sentence for a person: what is wrong, or what was checked */
  message: string;
  files: string[];
}

/**
 * Check a folder of downloaded release files: the signature on SHA256SUMS is valid under a pinned key, every file in the
 * folder is listed with the right hash, and every name in `require` is there. A file nobody signed fails the check, so a
 * swapped or added file cannot ride along. Run it with the salu already installed, never with a downloaded one.
 */
export function verifyDir(dir: string, o: { require?: string[]; pubs?: string[] } = {}): VerifyResult {
  const fail = (message: string): VerifyResult => ({ ok: false, message, files: [] });
  const pubs = o.pubs ?? RELEASE_PUBKEYS;
  if (!pubs.length) return fail('this salu has no release signing key built in yet, so it cannot check a download (salu release keygen, then commit the public key)');
  if (!existsSync(join(dir, SUMS)) || !existsSync(join(dir, SIG))) return fail(`${SUMS} and ${SIG} are missing: this release is not signed`);
  const sums = readFileSync(join(dir, SUMS));
  if (!sigOk(sums, readFileSync(join(dir, SIG), 'utf8'), pubs)) return fail('the signature on the release checksums is not valid: do not install it');
  let listed: Map<string, string>;
  try {
    listed = parseSums(sums.toString('utf8'));
  } catch (e: any) {
    return fail(e.message);
  }
  const files = readdirSync(dir).filter((f) => f !== SUMS && !f.endsWith('.sig') && statSync(join(dir, f)).isFile());
  for (const f of files) {
    const want = listed.get(f);
    if (!want) return fail(`${f} is not in the signed list: do not use it`);
    if (sha(join(dir, f)) !== want) return fail(`${f} does not match the signed checksum: do not use it`);
  }
  for (const r of o.require ?? []) if (!files.includes(r)) return fail(`${r} is missing from the download`);
  return { ok: true, message: `signature and ${files.length} file(s) verified`, files };
}

/** A detached signature over one file (how the box's update handler checks install-box.sh): same key, same domain. */
export function verifyFile(file: string, sigFile: string, pubs: string[] = RELEASE_PUBKEYS): VerifyResult {
  if (!pubs.length) return { ok: false, message: 'this salu has no release signing key built in yet, so it cannot check a download', files: [] };
  if (!existsSync(file) || !existsSync(sigFile)) return { ok: false, message: `${!existsSync(file) ? file : sigFile} is missing: this download is not signed`, files: [] };
  if (!sigOk(readFileSync(file), readFileSync(sigFile, 'utf8'), pubs)) return { ok: false, message: 'the signature does not match this file: do not run it', files: [] };
  return { ok: true, message: 'signature verified', files: [file] };
}
