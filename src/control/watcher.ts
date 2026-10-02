/** Box side of the control channel: poll the control repo, check each command, run its handler, write the reply. */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isId, newId } from '../sync/format.ts';
import { MAX_AGE_MS, MAX_FUTURE_MS, commandPath, commandsDir, heartbeatPath, parseMessage, replyPath, signHeartbeat, signReply, validateArgs, verifyMessage, type Reply, type Verb } from './message.ts';
import { openSealed } from './seal.ts';
import type { ControlTransport } from './transport.ts';

export type HandlerResult = { ok: boolean; message: string; data?: unknown };
export type Handlers = Record<Verb, (a: { args: any; secret(field: string): Buffer }) => Promise<HandlerResult>>;

export interface WatcherOptions {
  box: string;
  macKey: Buffer;
  boxKey: Buffer;
  sealKey: Buffer; // the box's private seal key
  intervalMs?: number;
  /** File of handled ids, one per line. Default /var/lib/salu/box/handled. */
  handledFile?: string;
  now?: () => number;
  /** What to put in the heartbeat (version, disk, tickets). Left out: no heartbeat. */
  heartbeat?: () => Record<string, unknown>;
  heartbeatMs?: number;
  onError?: (e: unknown) => void;
  onHandled?: (id: string, verb: string, ok: boolean) => void;
}

export const DEFAULT_HANDLED_FILE = '/var/lib/salu/box/handled';

const oneLine = (s: string, n = 300) => s.replace(/\s+/g, ' ').trim().slice(0, n);

export function runWatcher(t: ControlTransport, h: Handlers, o: WatcherOptions): { stop(): void; tick(): Promise<number> } {
  const handledFile = o.handledFile ?? DEFAULT_HANDLED_FILE;
  const now = o.now ?? Date.now;
  let stopped = false;
  let busy = false;
  let lastBeat = 0;
  const handled = new Set<string>();
  try {
    if (existsSync(handledFile)) for (const l of readFileSync(handledFile, 'utf8').split('\n')) if (l) handled.add(l);
  } catch {}

  const markHandled = (id: string) => {
    handled.add(id);
    mkdirSync(dirname(handledFile), { recursive: true });
    appendFileSync(handledFile, `${id}\n`, { mode: 0o600 });
  };

  async function reply(id: string, ok: boolean, message: string, data?: unknown): Promise<void> {
    const r: Omit<Reply, 'sig'> = { v: 1, id, box: o.box, ok, message: oneLine(message), ...(data !== undefined ? { data } : {}), at: now() };
    await t.put(replyPath(o.box, id), JSON.stringify(signReply(r, o.boxKey)));
  }

  async function handle(file: string): Promise<boolean> {
    const id = file.replace(/\.json$/, '');
    if (!isId(id) || !file.endsWith('.json') || handled.has(id)) return false;
    const text = await t.get(commandPath(o.box, id));
    if (text === undefined) return false;
    // At most once: a command counts as handled before it runs, so a crash never repeats a half-done verb.
    markHandled(id);
    const p = parseMessage(text);
    if (!p.ok) return await fail(id, `Ignored a command that was not valid (${p.reason}).`), true;
    const m = p.msg;
    if (m.id !== id || m.box !== o.box) return await fail(id, 'Ignored a command addressed to another box.'), true;
    if (!verifyMessage(m, o.macKey)) return await fail(id, 'Ignored a command with a bad signature. Pair this box again if the key changed.'), true;
    const age = now() - m.at;
    if (age > MAX_AGE_MS) return await fail(id, 'Ignored a command older than 24 hours. Send it again.'), true;
    if (age < -MAX_FUTURE_MS) return await fail(id, 'Ignored a command from the future. Check the clocks on both computers.'), true;
    const bad = validateArgs(m.verb, m.args, m.sealed);
    if (bad) return await fail(id, `Not run: ${bad}.`), true;
    const run = h[m.verb as Verb];
    if (!run) return await fail(id, `This box cannot run "${m.verb}" yet.`), true;
    let res: HandlerResult;
    try {
      res = await run({
        args: m.args,
        secret: (field) => {
          const s = m.sealed[field];
          if (s === undefined) throw new Error(`the command has no sealed "${field}"`);
          try {
            return openSealed(o.sealKey, s);
          } catch {
            throw new Error(`could not open sealed "${field}" (it was sealed to another box)`);
          }
        },
      });
    } catch (e: any) {
      res = { ok: false, message: `${m.verb} failed on the box: ${oneLine(String(e?.message ?? e), 200)}` };
    }
    await reply(id, res.ok, res.message, res.data);
    o.onHandled?.(id, m.verb, res.ok);
    return true;
  }
  async function fail(id: string, message: string): Promise<void> {
    await reply(id, false, message);
    o.onHandled?.(id, '?', false);
  }

  // Ticks run one after another; a timer tick that finds one running is skipped, an explicit tick waits.
  let running: Promise<unknown> = Promise.resolve();
  function tick(): Promise<number> {
    const p = running.then(tickOnce, tickOnce);
    running = p.catch(() => {});
    return p;
  }
  async function tickOnce(): Promise<number> {
    busy = true;
    try {
      let n = 0;
      const files = (await t.list(commandsDir(o.box))).filter((f) => /^\d{13}-[0-9a-f]{8}\.json$/.test(f) && !handled.has(f.slice(0, -5)));
      for (const f of files) {
        if (stopped) break;
        if (await handle(f)) n++;
      }
      if (o.heartbeat && now() - lastBeat >= (o.heartbeatMs ?? 60_000)) {
        lastBeat = now();
        await t.put(heartbeatPath(o.box), JSON.stringify(signHeartbeat({ v: 1, box: o.box, at: now(), data: o.heartbeat() }, o.boxKey)), { overwrite: true });
      }
      return n;
    } finally {
      busy = false;
    }
  }

  const every = o.intervalMs ?? 5000;
  const timer = setInterval(() => {
    if (!stopped && !busy) tick().catch((e) => o.onError?.(e));
  }, every);
  (timer as any).unref?.();
  tick().catch((e) => o.onError?.(e));
  return {
    tick,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

export { newId };
