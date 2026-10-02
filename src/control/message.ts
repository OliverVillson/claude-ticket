/** Wire format of the control channel. Contract: docs/control-channel.md. */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { MAX_FILE_BYTES, isId } from '../sync/format.ts';

export { MAX_FILE_BYTES, newId, isId } from '../sync/format.ts';

export type Verb = 'ping' | 'status' | 'login.set' | 'project.create' | 'project.remove' | 'update';
export const VERBS: readonly Verb[] = ['ping', 'status', 'login.set', 'project.create', 'project.remove', 'update'];
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const MAX_FUTURE_MS = 5 * 60 * 1000;

export interface Msg {
  v: 1;
  id: string;
  box: string;
  verb: Verb;
  at: number;
  args: Record<string, unknown>;
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
export interface Heartbeat {
  v: 1;
  box: string;
  at: number;
  data: Record<string, unknown>;
  sig: string;
}

export const commandPath = (box: string, id: string) => `boxes/${box}/commands/${id}.json`;
export const replyPath = (box: string, id: string) => `boxes/${box}/replies/${id}.json`;
export const heartbeatPath = (box: string) => `boxes/${box}/heartbeat.json`;
export const commandsDir = (box: string) => `boxes/${box}/commands`;

export const BOX_RE = /^[a-z0-9-]{1,32}$/;
export const NAME_RE = /^[a-z0-9-]{1,40}$/;
export const REPO_RE = /^git@github\.com:[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}\.git$/;
export const VERSION_RE = /^v?\d{1,4}\.\d{1,4}\.\d{1,4}(-[0-9A-Za-z.-]{1,20})?$/;

/** JSON with keys sorted at every level and no spaces. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

const mac = (o: object, key: Buffer): string => {
  const { sig: _sig, ...rest } = o as Record<string, unknown>;
  return createHmac('sha256', key).update(canonical(rest)).digest('hex');
};
function same(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function signMessage(m: Omit<Msg, 'sig'>, key: Buffer): Msg {
  return { ...m, sig: mac(m, key) };
}
export function verifyMessage(m: Msg, key: Buffer): boolean {
  return typeof m?.sig === 'string' && same(m.sig, mac(m, key));
}
export function signReply(r: Omit<Reply, 'sig'>, key: Buffer): Reply {
  return { ...r, sig: mac(r, key) };
}
export function verifyReply(r: Reply, key: Buffer): boolean {
  return typeof r?.sig === 'string' && same(r.sig, mac(r, key));
}
export function signHeartbeat(h: Omit<Heartbeat, 'sig'>, key: Buffer): Heartbeat {
  return { ...h, sig: mac(h, key) };
}
export function verifyHeartbeat(h: Heartbeat, key: Buffer): boolean {
  return typeof h?.sig === 'string' && same(h.sig, mac(h, key));
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

/** Parse a command file. Returns the message or a reason it is not one (never throws). */
export function parseMessage(text: string): { ok: true; msg: Msg } | { ok: false; reason: string } {
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) return { ok: false, reason: 'the file is too big' };
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'the file is not JSON' };
  }
  if (!isObj(j) || j.v !== 1) return { ok: false, reason: 'unknown format version' };
  if (!isId(j.id)) return { ok: false, reason: 'bad id' };
  if (typeof j.box !== 'string' || !BOX_RE.test(j.box)) return { ok: false, reason: 'bad box name' };
  if (typeof j.verb !== 'string') return { ok: false, reason: 'no verb' };
  if (typeof j.at !== 'number' || !Number.isFinite(j.at)) return { ok: false, reason: 'bad time' };
  if (!isObj(j.args)) return { ok: false, reason: 'bad args' };
  if (!isObj(j.sealed) || !Object.values(j.sealed).every((s) => typeof s === 'string')) return { ok: false, reason: 'bad sealed fields' };
  if (typeof j.sig !== 'string') return { ok: false, reason: 'not signed' };
  return { ok: true, msg: j as unknown as Msg };
}

export function parseReply(text: string): Reply | undefined {
  try {
    const j = JSON.parse(text);
    if (isObj(j) && j.v === 1 && isId(j.id) && typeof j.box === 'string' && typeof j.ok === 'boolean' && typeof j.message === 'string' && typeof j.at === 'number' && typeof j.sig === 'string') return j as unknown as Reply;
  } catch {}
  return undefined;
}

export function parseHeartbeat(text: string): Heartbeat | undefined {
  try {
    const j = JSON.parse(text);
    if (isObj(j) && j.v === 1 && typeof j.box === 'string' && typeof j.at === 'number' && isObj(j.data) && typeof j.sig === 'string') return j as unknown as Heartbeat;
  } catch {}
  return undefined;
}

interface Shape {
  args: Record<string, 'name' | 'repo' | 'version' | 'concurrency' | 'bool' | 'subscription'>;
  required: string[];
  sealed: string[];
}
const SHAPES: Record<Verb, Shape> = {
  ping: { args: {}, required: [], sealed: [] },
  status: { args: {}, required: [], sealed: [] },
  'login.set': { args: { kind: 'subscription' }, required: ['kind'], sealed: ['token'] },
  'project.create': { args: { name: 'name', repo: 'repo', concurrency: 'concurrency' }, required: ['name', 'repo'], sealed: ['deployKey', 'signingKey'] },
  'project.remove': { args: { name: 'name', purge: 'bool' }, required: ['name'], sealed: [] },
  update: { args: { version: 'version' }, required: [], sealed: [] },
};

/** Check a command's args and sealed fields against its verb. Returns a problem in plain words, or null. */
export function validateArgs(verb: string, args: Record<string, unknown>, sealed: Record<string, string>): string | null {
  if (!(VERBS as readonly string[]).includes(verb)) return `unknown command "${String(verb).slice(0, 40)}"`;
  const shape = SHAPES[verb as Verb];
  for (const k of Object.keys(args)) if (!(k in shape.args)) return `${verb} does not take "${k.slice(0, 40)}"`;
  for (const k of shape.required) if (args[k] === undefined) return `${verb} needs "${k}"`;
  for (const [k, kind] of Object.entries(shape.args)) {
    const v = args[k];
    if (v === undefined) continue;
    const ok =
      kind === 'name' ? typeof v === 'string' && NAME_RE.test(v)
      : kind === 'repo' ? typeof v === 'string' && REPO_RE.test(v)
      : kind === 'version' ? typeof v === 'string' && VERSION_RE.test(v)
      : kind === 'concurrency' ? Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 32
      : kind === 'bool' ? typeof v === 'boolean'
      : v === 'subscription';
    if (!ok) return `"${k}" is not valid for ${verb}`;
  }
  for (const k of Object.keys(sealed)) if (!shape.sealed.includes(k)) return `${verb} does not take a sealed "${k.slice(0, 40)}"`;
  for (const k of shape.sealed) if (sealed[k] === undefined) return `${verb} needs a sealed "${k}"`;
  return null;
}
