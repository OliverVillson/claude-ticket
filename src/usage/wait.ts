import type { Database } from 'bun:sqlite';
import { probeWindow, type ProbeOptions } from './probe.ts';
import { clearLimitPause, extendPause, getPause, isPauseDue, RESUME_MARGIN_MS } from './state.ts';
import { formatPause } from './format.ts';
import type { PauseState, ProbeResult, ResumeInfo } from './types.ts';

export interface WaitOptions {
  signal?: AbortSignal;
  /** How often to re-read the pause while sleeping (a `ticket resume` or a new hit changes it). Default 5 s. */
  pollMs?: number;
  /** Grace after a reset time reported by a probe. Default RESUME_MARGIN_MS. */
  margin?: number;
  /** Probe to run once the reset time has passed. Default: `probeWindow`. `false` resumes without probing. */
  probe?: ((state: PauseState) => Promise<ProbeResult>) | false;
  /** Passed to `probeWindow` (cwd, model, timeout, log). */
  probeOptions?: Partial<ProbeOptions>;
  /** After this many inconclusive probes in a row (a closed probe resets the count), resume anyway. Default 3. */
  maxUnknownProbes?: number;
  /** Override the backoffs (tests). */
  backoff?: { closed?: (attempt: number) => number; unknown?: (attempt: number) => number };
  /** Called on every poll while waiting, with the time left. */
  onTick?: (state: PauseState, msLeft: number) => void;
  log?: (line: string) => void;
}

/** Backoff when a probe says "closed" but gives no reset time: 10, 20, 40, then 60 minutes. */
export function closedBackoffMs(attempt: number): number {
  return Math.min(10 * 60_000 * 2 ** Math.max(0, attempt), 60 * 60_000);
}

/** Backoff when a probe is inconclusive: 2, 4, 8 minutes, capped at 10. */
export function unknownBackoffMs(attempt: number): number {
  return Math.min(2 * 60_000 * 2 ** Math.max(0, attempt), 10 * 60_000);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

async function runProbe(state: PauseState, opts: WaitOptions): Promise<ProbeResult> {
  if (opts.probe === false) return { status: 'open', detail: 'probe disabled' };
  if (opts.probe) return opts.probe(state);
  return probeWindow({
    ...opts.probeOptions,
    pause: { kind: state.kind, models: state.models },
    signal: opts.signal,
    log: opts.probeOptions?.log ?? opts.log,
  });
}

/**
 * One probe step for a pause whose reset time has passed. Returns the resume info when the
 * window is open (the pause is cleared), or null when it is still closed (the pause is extended).
 */
export async function probeAndResume(db: Database, state: PauseState, opts: WaitOptions = {}): Promise<ResumeInfo | null> {
  const log = opts.log ?? (() => {});
  const margin = opts.margin ?? RESUME_MARGIN_MS;
  const maxUnknown = opts.maxUnknownProbes ?? 3;
  const closedBackoff = opts.backoff?.closed ?? closedBackoffMs;
  const unknownBackoff = opts.backoff?.unknown ?? unknownBackoffMs;
  const result = await runProbe(state, opts);
  const now = Date.now();
  if (result.status === 'open') {
    clearLimitPause(db, now);
    log(`window open (${result.detail ?? 'probe'}); resuming after ${state.reason}`);
    return { state, confirmedBy: opts.probe === false ? 'unconfirmed' : 'probe' };
  }
  if (result.status === 'closed') {
    const hit = result.hit;
    const until = hit?.resetsAt != null && hit.resetsAt > now ? hit.resetsAt + margin : now + closedBackoff(state.probeAttempts);
    const next = extendPause(db, until, hit, now);
    log(`still closed (${result.detail ?? hit?.raw ?? 'probe'}); ${formatPause(next, now)}`);
    return null;
  }
  if (state.unknownProbes + 1 >= maxUnknown) {
    clearLimitPause(db, now);
    log(`probe inconclusive ${state.unknownProbes + 1} times in a row (${result.detail ?? ''}); resuming anyway`);
    return { state, confirmedBy: 'unconfirmed' };
  }
  const next = extendPause(db, now + unknownBackoff(state.unknownProbes), undefined, now, { unknown: true });
  log(`probe inconclusive (${result.detail ?? ''}); ${formatPause(next, now)}`);
  return null;
}

/**
 * Non-blocking check for an orchestrator that runs its own loop: if a limit pause is due, probe
 * once and clear it when the window is open. Returns immediately with null when nothing is due.
 */
export async function resumeIfDue(db: Database, opts: WaitOptions = {}): Promise<ResumeInfo | null> {
  const state = getPause(db);
  if (!isPauseDue(state)) return null;
  return probeAndResume(db, state!, opts);
}

/**
 * Block until dispatch may continue. Resolves with how the pause ended, or null when the abort
 * signal fired. Returns at once (with `confirmedBy: 'manual'`) when there is no pause.
 *
 * While waiting: sleeps in `pollMs` chunks so `ticket resume` (which clears the pause) and new
 * hits (which extend it) are noticed; once the reset time passes, probes; on "still closed"
 * re-arms from the probe's reset time; on repeated inconclusive probes resumes anyway.
 */
export async function waitUntilOpen(db: Database, opts: WaitOptions = {}): Promise<ResumeInfo | null> {
  const pollMs = opts.pollMs ?? 5_000;
  const signal = opts.signal;
  let last: PauseState | null = null;
  for (;;) {
    if (signal?.aborted) return null;
    const state = getPause(db);
    if (!state) {
      return { state: last ?? { kind: 'unknown', reason: 'not paused', until: 0, models: [], manual: false, since: Date.now(), source: 'manual', probeAttempts: 0, unknownProbes: 0 }, confirmedBy: 'manual' };
    }
    last = state;
    if (state.manual) {
      opts.onTick?.(state, -1);
      await sleep(pollMs, signal);
      continue;
    }
    const left = state.until - Date.now();
    if (left > 0) {
      opts.onTick?.(state, left);
      await sleep(Math.min(left, pollMs), signal);
      continue;
    }
    const resumed = await probeAndResume(db, state, opts);
    if (resumed) return resumed;
  }
}

/** Alias of `resumeIfDue` under the name the core's contract uses. */
export const probeAndMaybeResume = resumeIfDue;
