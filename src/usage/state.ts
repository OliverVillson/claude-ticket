import type { Database } from 'bun:sqlite';
import { STATE } from '../db/types.ts';
import { getState, setState } from '../db/queries.ts';
import { labelForKind } from './detect.ts';
import type { GateResult, LimitHit, LimitKind, LimitSource, PauseState } from './types.ts';

/**
 * Pause bookkeeping in the `state` table. Uses the core's STATE keys for what `ticket status`,
 * `ticket pause`/`resume`, the orchestrator and the TUI read (paused_until, pause_reason,
 * pause_kind, pause_models, manual_pause) plus a few `usage_*` keys of its own.
 */
export const USAGE_STATE = {
  since: 'usage_paused_since', // epoch ms
  source: 'usage_pause_source', // LimitSource
  probeAttempts: 'usage_probe_attempts',
  unknownProbes: 'usage_probe_unknown', // inconclusive probes in a row
  lastHit: 'usage_last_hit', // JSON LimitHit
  lastResume: 'usage_last_resume', // epoch ms
} as const;

/** Grace added after the reported reset before the first probe, so clock skew does not waste a probe. */
export const RESUME_MARGIN_MS = 60_000;
/** Wait when a limit is reported without a reset time. */
export const UNKNOWN_RESET_WAIT_MS = 10 * 60_000;

function parseModels(v: string | null): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** The current pause, or null when dispatch is allowed for every model. */
export function getPause(db: Database): PauseState | null {
  const manual = getState(db, STATE.manualPause) === '1';
  const untilRaw = getState(db, STATE.pausedUntil);
  const until = untilRaw ? Number(untilRaw) : 0;
  const hasLimit = Number.isFinite(until) && until > 0;
  if (!manual && !hasLimit) return null;
  const kind: LimitKind = hasLimit ? ((getState(db, STATE.pauseKind) as LimitKind | null) ?? 'unknown') : 'manual';
  const models = parseModels(getState(db, STATE.pauseModels));
  const sinceRaw = getState(db, USAGE_STATE.since);
  return {
    kind,
    reason: getState(db, STATE.pauseReason) ?? labelForKind(kind, models),
    until: hasLimit ? until : 0,
    models: hasLimit ? models : [],
    manual,
    since: sinceRaw ? Number(sinceRaw) : Date.now(),
    source: (getState(db, USAGE_STATE.source) as LimitSource | null) ?? (hasLimit ? 'error_text' : 'manual'),
    probeAttempts: Number(getState(db, USAGE_STATE.probeAttempts) ?? 0) || 0,
    unknownProbes: Number(getState(db, USAGE_STATE.unknownProbes) ?? 0) || 0,
  };
}

export interface EnterPauseOptions {
  now?: number;
  /** Grace after the reported reset time. Default RESUME_MARGIN_MS. */
  margin?: number;
  /** Wait when the hit carries no reset time. Default UNKNOWN_RESET_WAIT_MS. */
  unknownWait?: number;
}

/**
 * Record a limit hit. Idempotent: a second hit while paused keeps the later reset time and
 * widens the model set (an all-models pause absorbs a model-specific one, never the reverse).
 * A manual pause underneath is kept.
 */
export function enterPause(db: Database, hit: LimitHit, opts: EnterPauseOptions = {}): PauseState {
  const now = opts.now ?? Date.now();
  const margin = opts.margin ?? RESUME_MARGIN_MS;
  const unknownWait = opts.unknownWait ?? UNKNOWN_RESET_WAIT_MS;
  const prev = getPause(db);
  const prevLimit = prev && prev.until > 0 ? prev : null;

  let until = hit.resetsAt != null && hit.resetsAt > now ? hit.resetsAt + margin : now + unknownWait;
  let models = [...hit.models];
  let kind: LimitKind = hit.kind;
  if (prevLimit) {
    const prevAll = prevLimit.models.length === 0;
    const hitAll = hit.models.length === 0;
    if (prevAll && !hitAll) {
      models = [];
      kind = prevLimit.kind;
    } else if (!prevAll && !hitAll) {
      models = Array.from(new Set([...prevLimit.models, ...hit.models]));
      if (models.length > 1) kind = 'model';
    }
    if (prevLimit.until > until) until = prevLimit.until;
  }
  const tx = db.transaction(() => {
    setState(db, STATE.pausedUntil, until);
    setState(db, STATE.pauseKind, kind);
    setState(db, STATE.pauseReason, labelForKind(kind, models));
    setState(db, STATE.pauseModels, models.join(','));
    if (!prevLimit) setState(db, USAGE_STATE.since, prev?.manual ? prev.since : now);
    setState(db, USAGE_STATE.source, hit.source);
    setState(db, USAGE_STATE.probeAttempts, 0);
    setState(db, USAGE_STATE.unknownProbes, 0);
    setState(db, USAGE_STATE.lastHit, JSON.stringify(hit));
  });
  tx();
  return getPause(db)!;
}

/** Alias of `enterPause` under the name the core's contract uses. */
export const recordLimitHit = enterPause;

/** `ticket pause`: stop dispatch until `ticket resume`. Keeps any limit pause underneath. */
export function enterManualPause(db: Database, now = Date.now()): PauseState {
  const tx = db.transaction(() => {
    setState(db, STATE.manualPause, '1');
    if (getState(db, USAGE_STATE.since) == null) setState(db, USAGE_STATE.since, now);
    if (getState(db, USAGE_STATE.source) == null) setState(db, USAGE_STATE.source, 'manual');
  });
  tx();
  return getPause(db)!;
}

/** Clear every pause (limit and manual). `ticket resume` calls this. */
export function clearPause(db: Database, now = Date.now()): void {
  const tx = db.transaction(() => {
    for (const k of [STATE.pausedUntil, STATE.pauseReason, STATE.pauseKind, STATE.pauseModels, STATE.manualPause]) setState(db, k, null);
    for (const k of [USAGE_STATE.since, USAGE_STATE.source, USAGE_STATE.probeAttempts, USAGE_STATE.unknownProbes]) setState(db, k, null);
    setState(db, USAGE_STATE.lastResume, now);
  });
  tx();
}

/**
 * Clear the limit pause but keep a manual pause (`ticket pause`) in place. The auto-resume
 * uses this: a probe never overrides a pause a person asked for.
 */
export function clearLimitPause(db: Database, now = Date.now()): void {
  const tx = db.transaction(() => {
    for (const k of [STATE.pausedUntil, STATE.pauseReason, STATE.pauseKind, STATE.pauseModels]) setState(db, k, null);
    for (const k of [USAGE_STATE.since, USAGE_STATE.source, USAGE_STATE.probeAttempts, USAGE_STATE.unknownProbes]) setState(db, k, null);
    setState(db, USAGE_STATE.lastResume, now);
    if (getState(db, STATE.manualPause) === '1') {
      setState(db, USAGE_STATE.since, now);
      setState(db, USAGE_STATE.source, 'manual');
    }
  });
  tx();
}

/** Clear only the manual flag; a limit pause underneath stays. */
export function clearManualPause(db: Database): void {
  setState(db, STATE.manualPause, null);
  if (getPause(db) == null) clearPause(db);
}

/**
 * Push the reset time out after a probe. Counts a probe attempt. `unknown: true` marks an
 * inconclusive probe (counted in a row); a closed probe resets that streak.
 */
export function extendPause(db: Database, until: number, hit?: LimitHit, now = Date.now(), opts: { unknown?: boolean } = {}): PauseState | null {
  const prev = getPause(db);
  if (!prev || !(prev.until > 0)) return prev;
  const tx = db.transaction(() => {
    setState(db, STATE.pausedUntil, Math.max(until, now + 100));
    setState(db, USAGE_STATE.probeAttempts, prev.probeAttempts + 1);
    setState(db, USAGE_STATE.unknownProbes, opts.unknown ? prev.unknownProbes + 1 : 0);
    if (hit) {
      setState(db, USAGE_STATE.lastHit, JSON.stringify(hit));
      setState(db, USAGE_STATE.source, hit.source);
      if (prev.models.length === 0 && hit.models.length === 0 && hit.kind !== 'unknown' && hit.kind !== prev.kind) {
        setState(db, STATE.pauseKind, hit.kind);
        setState(db, STATE.pauseReason, labelForKind(hit.kind, []));
      }
    }
  });
  tx();
  return getPause(db);
}

/** The last limit that was seen, for logs and a verbose status. */
export function lastHit(db: Database): LimitHit | null {
  const raw = getState(db, USAGE_STATE.lastHit);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LimitHit;
  } catch {
    return null;
  }
}

/** When the last pause ended, epoch ms, or null. */
export function lastResumeAt(db: Database): number | null {
  const v = getState(db, USAGE_STATE.lastResume);
  return v ? Number(v) : null;
}

/** Does a pause on `models` cover `model`? Empty `models` means everything. */
export function pauseCoversModel(models: string[], model: string | null | undefined): boolean {
  if (models.length === 0) return true;
  if (!model) return false; // model unknown (Claude Code's default): only an all-models pause blocks it
  const m = model.toLowerCase();
  return models.some((p) => m.includes(p.toLowerCase()));
}

/**
 * Synchronous dispatch check. Closed while a manual pause is on, or while a limit pause covers
 * the model. A limit pause stays closed after its reset time until `waitUntilOpen` /
 * `resumeIfDue` (or `ticket resume`) clears it, so a probe always precedes resumption.
 */
export function gateFor(db: Database, model: string | null | undefined): GateResult {
  const state = getPause(db);
  if (!state) return { open: true };
  if (state.manual) return { open: false, state };
  if (!pauseCoversModel(state.models, model)) return { open: true };
  return { open: false, state };
}

/** `true` when a ticket on `model` may be dispatched now. Convenience over `gateFor`. */
export function dispatchAllowed(db: Database, model: string | null | undefined): boolean {
  return gateFor(db, model).open;
}

/** True when a limit pause's reset time has passed and a probe is due. */
export function isPauseDue(state: PauseState | null, now = Date.now()): boolean {
  return !!state && !state.manual && state.until > 0 && now >= state.until;
}
