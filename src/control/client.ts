/** Mac side of the control channel: send a signed command, wait for the box's signed reply. */
import { isId, newId } from '../sync/format.ts';
import { commandPath, heartbeatPath, parseHeartbeat, parseReply, replyPath, signMessage, validateArgs, verifyHeartbeat, verifyReply, type Heartbeat, type Reply, type Verb } from './message.ts';
import { sealTo } from './seal.ts';
import type { ControlTransport } from './transport.ts';

export interface BoxConfig {
  box: string;
  macKey: Buffer; // signs commands
  boxKey: Buffer; // checks replies and heartbeats
  sealPub: Buffer; // the box's public seal key
}

/** Returns the command's id. Secrets are sealed to the box; they are never put in args. */
export async function sendCommand(t: ControlTransport, cfg: BoxConfig, verb: Verb, args: object = {}, secrets: Record<string, Buffer> = {}): Promise<string> {
  const sealed: Record<string, string> = {};
  for (const [k, v] of Object.entries(secrets)) sealed[k] = sealTo(cfg.sealPub, v);
  const bad = validateArgs(verb, args as Record<string, unknown>, sealed);
  if (bad) throw new Error(`cannot send ${verb}: ${bad}`);
  const id = newId();
  const m = signMessage({ v: 1, id, box: cfg.box, verb, at: Date.now(), args: args as Record<string, unknown>, sealed }, cfg.macKey);
  await t.put(commandPath(cfg.box, id), JSON.stringify(m));
  return id;
}

/** Waits for the reply to `id`. A reply with a bad signature is ignored (it is not from the box). */
export async function waitReply(t: ControlTransport, cfg: BoxConfig, id: string, o: { timeoutMs?: number; pollMs?: number } = {}): Promise<Reply> {
  if (!isId(id)) throw new Error('bad command id');
  const until = Date.now() + (o.timeoutMs ?? 60_000);
  for (;;) {
    const text = await t.get(replyPath(cfg.box, id));
    if (text !== undefined) {
      const r = parseReply(text);
      if (r && r.id === id && r.box === cfg.box && verifyReply(r, cfg.boxKey)) return r;
    }
    if (Date.now() >= until) throw new Error(`no answer from ${cfg.box} yet. Is the box on and online? Run the same command again to keep waiting.`);
    await new Promise((res) => setTimeout(res, o.pollMs ?? 1500));
  }
}

/** The box's last heartbeat, if it is signed by the box. */
export async function readHeartbeat(t: ControlTransport, cfg: BoxConfig): Promise<Heartbeat | undefined> {
  const text = await t.get(heartbeatPath(cfg.box));
  const h = text === undefined ? undefined : parseHeartbeat(text);
  return h && h.box === cfg.box && verifyHeartbeat(h, cfg.boxKey) ? h : undefined;
}
