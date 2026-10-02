import { createHmac } from 'node:crypto';
import { snapshot } from './handlers/status.ts';
import type { BoxDeps } from './handlers/types.ts';

/** Canonical JSON of the contract: keys sorted, no spaces. The HMAC covers the object without `sig`. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter((k) => (v as any)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson((v as any)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/** The signed body of `boxes/<box>/heartbeat.json`. */
export async function heartbeatBody(deps: BoxDeps, box: string, boxKey: Buffer): Promise<string> {
  const s = await snapshot(deps);
  const body = { v: 1, box, at: deps.now(), version: s.version, disk: s.disk, tickets: s.tickets, projects: s.projects.map((p) => ({ project: p.project, service: p.service, running: p.running, todo: p.todo })) };
  return JSON.stringify({ ...body, sig: createHmac('sha256', boxKey).update(canonicalJson(body)).digest('hex') });
}

/**
 * Rewrite heartbeat.json every 60 s. `put` is the transport's (`put` has to overwrite this one path; the write-once
 * rule is for commands and replies). A failed beat is skipped and tried again next minute, never fatal.
 */
export function startHeartbeat(o: { deps: BoxDeps; box: string; boxKey: Buffer; put(path: string, body: string): Promise<void>; intervalMs?: number; onError?(e: unknown): void }): { stop(): void; beat(): Promise<void> } {
  const beat = async () => {
    try {
      await o.put(`boxes/${o.box}/heartbeat.json`, await heartbeatBody(o.deps, o.box, o.boxKey));
    } catch (e) {
      o.onError?.(e);
    }
  };
  void beat();
  const t = setInterval(beat, o.intervalMs ?? 60_000);
  t.unref?.();
  return { stop: () => clearInterval(t), beat };
}
