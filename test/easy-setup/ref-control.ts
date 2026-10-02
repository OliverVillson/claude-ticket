/**
 * Reference implementation of docs/control-channel.md, used by the fake-box harness until src/control/ lands
 * (control.ts picks the real code as soon as it exists). It is deliberately small and follows the contract
 * to the letter, so a real piece that disagrees with it fails the same tests.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { newId } from '../../src/sync/format.ts';
import { git } from '../../src/sync/git.ts';

export type Verb = 'ping' | 'status' | 'login.set' | 'project.create' | 'project.remove' | 'update';
export interface Msg {
  v: 1;
  id: string;
  box: string;
  verb: Verb;
  at: number;
  args: any;
  sealed: Record<string, string>;
  sig: string;
}
export interface Reply {
  v: 1;
  id: string;
  box: string;
  ok: boolean;
  message: string;
  data?: unknown;
  at: number;
  sig: string;
}
export interface BoxConfig {
  box: string;
  macKey: Buffer;
  boxKey: Buffer;
  sealPub: Buffer;
}

// ---- seal: epk(32) | iv(12) | tag(16) | ct
const X25519_SPKI = Buffer.from('302a300506032b656e032100', 'hex');
const X25519_PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
export function newSealKeys(): { pub: Buffer; priv: Buffer } {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return { pub: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32), priv: privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32) };
}
const pubObj = (b: Buffer) => createPublicKey({ key: Buffer.concat([X25519_SPKI, b]), format: 'der', type: 'spki' });
const privObj = (b: Buffer) => createPrivateKey({ key: Buffer.concat([X25519_PKCS8, b]), format: 'der', type: 'pkcs8' });
const kdf = (shared: Buffer, epk: Buffer, rpk: Buffer) => Buffer.from(hkdfSync('sha256', shared, Buffer.concat([epk, rpk]), 'salu-control-seal', 32));

export function sealTo(boxPublicKey: Buffer, plaintext: Buffer): string {
  const e = newSealKeys();
  const key = kdf(diffieHellman({ privateKey: privObj(e.priv), publicKey: pubObj(boxPublicKey) }), e.pub, boxPublicKey);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([e.pub, iv, c.getAuthTag(), ct]).toString('base64');
}
export function openSealed(boxPrivateKey: Buffer, sealed: string): Buffer {
  const b = Buffer.from(sealed, 'base64');
  if (b.length < 60) throw new Error('sealed box too short');
  const epk = b.subarray(0, 32);
  const priv = privObj(boxPrivateKey);
  const rpk = createPublicKey(priv).export({ type: 'spki', format: 'der' }).subarray(-32);
  const key = kdf(diffieHellman({ privateKey: priv, publicKey: pubObj(epk) }), epk, rpk);
  const d = createDecipheriv('aes-256-gcm', key, b.subarray(32, 44));
  d.setAuthTag(b.subarray(44, 60));
  return Buffer.concat([d.update(b.subarray(60)), d.final()]);
}

// ---- messages
const canon = (v: any): string => (v && typeof v === 'object' ? (Array.isArray(v) ? `[${v.map(canon).join(',')}]` : `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`) : JSON.stringify(v));
const mac = (m: object, key: Buffer) => createHmac('sha256', key).update(canon(m)).digest('hex');
export function signMessage<T extends object>(m: T, key: Buffer): T & { sig: string } {
  const { sig: _drop, ...rest } = m as any;
  return { ...rest, sig: mac(rest, key) };
}
export function verifyMessage(m: any, key: Buffer): boolean {
  if (!m || typeof m.sig !== 'string' || !/^[0-9a-f]{64}$/.test(m.sig)) return false;
  const { sig, ...rest } = m;
  return timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(mac(rest, key), 'hex'));
}

// ---- transport: a working copy of a (local bare) git repo
export interface ControlTransport {
  put(path: string, body: string): Promise<void>;
  list(dir: string): Promise<string[]>;
  get(path: string): Promise<string | undefined>;
}
export function gitTransport(opts: { url: string; sshKey?: string; dir: string }): ControlTransport {
  const g = (args: string[]) => git(opts.dir, args);
  if (!existsSync(join(opts.dir, '.git'))) {
    mkdirSync(opts.dir, { recursive: true });
    git(opts.dir, ['init', '-q', '-b', 'main']);
    git(opts.dir, ['remote', 'add', 'origin', opts.url]);
    git(opts.dir, ['config', 'user.email', 'salu@example.invalid']);
    git(opts.dir, ['config', 'user.name', 'salu']);
  }
  const refresh = () => {
    const f = g(['fetch', '-q', 'origin', 'main']);
    if (f.ok) g(['checkout', '-q', '-f', '-B', 'main', 'origin/main']);
  };
  return {
    async put(path, body) {
      if (Buffer.byteLength(body) > 64 * 1024) throw new Error('file over 64 KiB');
      for (let i = 0; i < 8; i++) {
        refresh();
        const p = join(opts.dir, path);
        if (existsSync(p)) throw new Error(`${path} already exists (files are write-once)`);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, body, { flag: 'wx' });
        g(['add', path]);
        g(['commit', '-q', '-m', `salu: ${path}`]);
        if (g(['push', '-q', 'origin', 'HEAD:refs/heads/main']).ok) return;
        g(['reset', '-q', '--hard']);
      }
      throw new Error('could not push after several tries');
    },
    async list(dir) {
      refresh();
      const p = join(opts.dir, dir);
      return existsSync(p) ? readdirSync(p).filter((n) => !n.startsWith('.')).sort() : [];
    },
    async get(path) {
      refresh();
      const p = join(opts.dir, path);
      return existsSync(p) ? readFileSync(p, 'utf8') : undefined;
    },
  };
}

// ---- watcher (box side)
export type Handlers = Record<Verb, (a: { args: any; secret(field: string): Buffer }) => Promise<{ ok: boolean; message: string; data?: unknown }>>;
const VERBS = new Set<string>(['ping', 'status', 'login.set', 'project.create', 'project.remove', 'update']);
export const MAX_AGE_MS = 24 * 3600 * 1000;
export function runWatcher(t: ControlTransport, h: Handlers, o: { box: string; macKey: Buffer; boxKey: Buffer; sealKey: Buffer; intervalMs?: number; handledFile?: string; onError?: (e: unknown) => void }): { stop(): void } {
  const handled = new Set<string>();
  if (o.handledFile && existsSync(o.handledFile)) for (const l of readFileSync(o.handledFile, 'utf8').split('\n')) if (l) handled.add(l);
  let stopped = false;
  let busy = false;
  const answer = async (id: string, ok: boolean, message: string, data?: unknown) => {
    const r = signMessage({ v: 1 as const, id, box: o.box, ok, message, data, at: Date.now() }, o.boxKey);
    await t.put(`boxes/${o.box}/replies/${id}.json`, JSON.stringify(r));
  };
  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      for (const name of await t.list(`boxes/${o.box}/commands`)) {
        const id = name.replace(/\.json$/, '');
        if (handled.has(id)) continue;
        handled.add(id);
        if (o.handledFile) appendFileSync(o.handledFile, `${id}\n`);
        let m: any;
        try {
          m = JSON.parse((await t.get(`boxes/${o.box}/commands/${name}`)) ?? '');
        } catch {
          continue;
        }
        if (!verifyMessage(m, o.macKey)) {
          await answer(id, false, 'bad signature: this command was not signed with this box\'s key; run salu box add again');
          continue;
        }
        if (m.id !== id || m.box !== o.box) {
          await answer(id, false, 'the command is not addressed to this box');
          continue;
        }
        if (Date.now() - m.at > MAX_AGE_MS) continue;
        if (!VERBS.has(m.verb)) {
          await answer(id, false, `unknown command ${String(m.verb).slice(0, 40)}; update the box with salu box update`);
          continue;
        }
        try {
          const r = await h[m.verb as Verb]({ args: m.args ?? {}, secret: (f) => openSealed(o.sealKey, (m.sealed ?? {})[f] ?? '') });
          await answer(id, r.ok, r.message, r.data);
        } catch (e: any) {
          await answer(id, false, `that did not work on the box: ${String(e?.message ?? e).split('\n')[0]!.slice(0, 200)}`);
        }
      }
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick().catch(() => {}), o.intervalMs ?? 1000);
  void tick().catch(() => {});
  return { stop: () => ((stopped = true), clearInterval(timer)) };
}

// ---- client (Mac side)
export async function sendCommand(t: ControlTransport, cfg: BoxConfig, verb: Verb, args: object, secrets: Record<string, Buffer> = {}): Promise<string> {
  const id = newId();
  const sealed = Object.fromEntries(Object.entries(secrets).map(([k, v]) => [k, sealTo(cfg.sealPub, v)]));
  const m = signMessage({ v: 1 as const, id, box: cfg.box, verb, at: Date.now(), args, sealed }, cfg.macKey);
  await t.put(`boxes/${cfg.box}/commands/${id}.json`, JSON.stringify(m));
  return id;
}
export async function waitReply(t: ControlTransport, cfg: BoxConfig, id: string, o: { timeoutMs?: number } = {}): Promise<Reply> {
  const end = Date.now() + (o.timeoutMs ?? 30000);
  while (Date.now() < end) {
    const text = await t.get(`boxes/${cfg.box}/replies/${id}.json`);
    if (text) {
      const r = JSON.parse(text);
      if (!verifyMessage(r, cfg.boxKey)) throw new Error('the reply was not signed by this box');
      return r;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`no answer from the box within ${Math.round((o.timeoutMs ?? 30000) / 1000)} s`);
}

export const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
export const rm = (p: string) => rmSync(p, { recursive: true, force: true });
export const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
