import type { Database } from 'bun:sqlite';
import { getAllState, setState } from '../db/queries.ts';
import { STATE } from '../db/types.ts';

export const HEARTBEAT_MS = 5_000;
export const STALE_MS = 20_000;
export const WORKER_PREFIX = 'worker:';

/** Live info the orchestrator keeps per running worker, in state under `worker:<ticketId>`. */
export interface WorkerInfo {
  ticketId: number;
  runId: number;
  startedAt: number;
  turns: number;
  lastTool: string | null;
  lastText: string | null;
  model: string | null;
  sessionId: string | null;
  updatedAt: number;
}

export interface PauseInfo {
  until: number | null; // epoch ms
  reason: string | null;
  kind: string | null; // session | weekly | opus | sonnet | manual | unknown
  models: string[]; // empty = all models
  manual: boolean;
}

export interface OrchestratorStatus {
  alive: boolean;
  pid: number | null;
  heartbeat: number | null;
  startedAt: number | null;
  paused: PauseInfo | null;
  workers: WorkerInfo[];
  concurrency: number | null;
}

export function readStatus(db: Database, now = Date.now()): OrchestratorStatus {
  const s = getAllState(db);
  const pid = s[STATE.pid] ? Number(s[STATE.pid]) : null;
  const heartbeat = s[STATE.heartbeat] ? Number(s[STATE.heartbeat]) : null;
  let alive = !!pid && !!heartbeat && now - heartbeat < STALE_MS;
  if (alive && pid) alive = pidAlive(pid);
  const workers: WorkerInfo[] = [];
  for (const [k, v] of Object.entries(s)) {
    if (!k.startsWith(WORKER_PREFIX)) continue;
    try {
      workers.push(JSON.parse(v));
    } catch {
      /* ignore */
    }
  }
  workers.sort((a, b) => a.startedAt - b.startedAt);
  const manual = s[STATE.manualPause] === '1';
  const until = s[STATE.pausedUntil] ? Number(s[STATE.pausedUntil]) : null;
  const paused: PauseInfo | null =
    manual || (until != null && until > now)
      ? {
          until: manual ? null : until,
          reason: s[STATE.pauseReason] ?? (manual ? 'paused by `salu pause`' : null),
          kind: s[STATE.pauseKind] ?? (manual ? 'manual' : null),
          models: (s[STATE.pauseModels] ?? '').split(',').filter(Boolean),
          manual,
        }
      : null;
  return {
    alive,
    pid,
    heartbeat,
    startedAt: s[STATE.startedAt] ? Number(s[STATE.startedAt]) : null,
    paused,
    workers: alive ? workers : [],
    concurrency: s[STATE.concurrency] ? Number(s[STATE.concurrency]) : null,
  };
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM';
  }
}

export function setPause(db: Database, p: { until: number | null; reason: string; kind: string; models?: string[]; manual?: boolean }) {
  setState(db, STATE.pausedUntil, p.until);
  setState(db, STATE.pauseReason, p.reason);
  setState(db, STATE.pauseKind, p.kind);
  setState(db, STATE.pauseModels, (p.models ?? []).join(','));
  setState(db, STATE.manualPause, p.manual ? '1' : null);
}

export function clearPause(db: Database) {
  setState(db, STATE.pausedUntil, null);
  setState(db, STATE.pauseReason, null);
  setState(db, STATE.pauseKind, null);
  setState(db, STATE.pauseModels, null);
  setState(db, STATE.manualPause, null);
}

export function writeWorkerInfo(db: Database, w: WorkerInfo) {
  setState(db, `${WORKER_PREFIX}${w.ticketId}`, JSON.stringify(w));
}

export function clearWorkerInfo(db: Database, ticketId: number) {
  setState(db, `${WORKER_PREFIX}${ticketId}`, null);
}

export function clearAllWorkerInfo(db: Database) {
  for (const k of Object.keys(getAllState(db))) if (k.startsWith(WORKER_PREFIX)) setState(db, k, null);
}
