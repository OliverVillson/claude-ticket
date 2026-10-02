/**
 * Sealed boxes: encrypt a secret to a box's public key so only the box can read it.
 * node:crypto equivalent of crypto_box_seal: ephemeral X25519 key + HKDF-SHA256 + AES-256-GCM.
 * Format (base64): epk(32) | iv(12) | tag(16) | ciphertext.
 */
import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, type KeyObject } from 'node:crypto';

const INFO = Buffer.from('salu-control-seal-v1');
// DER prefixes that wrap a raw 32-byte X25519 key.
const SPKI = Buffer.from('302a300506032b656e032100', 'hex');
const PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');

const pub = (raw: Buffer): KeyObject => createPublicKey({ key: Buffer.concat([SPKI, raw]), format: 'der', type: 'spki' });
const priv = (raw: Buffer): KeyObject => createPrivateKey({ key: Buffer.concat([PKCS8, raw]), format: 'der', type: 'pkcs8' });

function need32(b: Buffer, what: string): void {
  if (!Buffer.isBuffer(b) || b.length !== 32) throw new Error(`${what} must be 32 bytes`);
}

/** A fresh X25519 key pair as raw 32-byte buffers. */
export function generateSealKeys(): { publicKey: Buffer; privateKey: Buffer } {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return {
    publicKey: (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(SPKI.length),
    privateKey: (privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).subarray(PKCS8.length),
  };
}

function aesKey(shared: Buffer, epk: Buffer, boxPub: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', shared, Buffer.concat([epk, boxPub]), INFO, 32));
}

export function sealTo(boxPublicKey: Buffer, plaintext: Buffer): string {
  need32(boxPublicKey, 'public key');
  const eph = generateKeyPairSync('x25519');
  const epk = (eph.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(SPKI.length);
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: pub(boxPublicKey) });
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', aesKey(shared, epk, boxPublicKey), iv);
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([epk, iv, c.getAuthTag(), ct]).toString('base64');
}

/** Throws when the box is not the one sealed to, or the data was changed. */
export function openSealed(boxPrivateKey: Buffer, sealed: string): Buffer {
  need32(boxPrivateKey, 'private key');
  const raw = Buffer.from(sealed, 'base64');
  if (raw.length < 32 + 12 + 16) throw new Error('sealed value is too short');
  const epk = raw.subarray(0, 32);
  const iv = raw.subarray(32, 44);
  const tag = raw.subarray(44, 60);
  const ct = raw.subarray(60);
  const sk = priv(boxPrivateKey);
  const boxPub = (createPublicKey(sk).export({ format: 'der', type: 'spki' }) as Buffer).subarray(SPKI.length);
  const shared = diffieHellman({ privateKey: sk, publicKey: pub(Buffer.from(epk)) });
  const d = createDecipheriv('aes-256-gcm', aesKey(shared, Buffer.from(epk), boxPub), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}
