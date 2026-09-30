/**
 * Usage-window pause/resume for the ticket orchestrator.
 *
 *   import { detectLimit, enterPause, gateFor, waitUntilOpen, resumeIfDue, clearPause, getPause, formatPause } from '../usage/index.ts';
 *
 * Flow: `detectLimit(msg)` on every worker message → `enterPause(db, hit)` → `gateFor(db, model)`
 * before each dispatch → `await waitUntilOpen(db, { signal })` (or `resumeIfDue` from a loop) →
 * dispatch again. `ticket pause` / `ticket resume` are `enterManualPause` / `clearPause`.
 */
export type { LimitHit, LimitKind, LimitSource, PauseState, GateResult, ProbeResult, RateLimitType, ResumeInfo } from './types.ts';
export {
  detectLimit,
  parseLimitText,
  parseResetPhrase,
  limitFromRateLimitInfo,
  isRateLimitRetry,
  labelForKind,
  kindForWindow,
  toEpochMs,
  LIMIT_TEXT_PREFIXES,
  WINDOW_LABELS,
} from './detect.ts';
export {
  getPause,
  enterPause,
  enterManualPause,
  clearPause,
  clearLimitPause,
  clearManualPause,
  dispatchAllowed,
  recordLimitHit,
  extendPause,
  gateFor,
  isPauseDue,
  pauseCoversModel,
  lastHit,
  lastResumeAt,
  RESUME_MARGIN_MS,
  UNKNOWN_RESET_WAIT_MS,
  USAGE_STATE,
} from './state.ts';
export type { EnterPauseOptions } from './state.ts';
export { formatPause, formatDuration, formatResetTime, formatClock } from './format.ts';
export { probeWindow, fakeProbe, interpretUsage, probeModelFor, probeResultFromRateLimitInfo } from './probe.ts';
export type { ProbeOptions, QueryLike } from './probe.ts';
export { waitUntilOpen, resumeIfDue, probeAndMaybeResume, probeAndResume, sleep, closedBackoffMs, unknownBackoffMs } from './wait.ts';
export type { WaitOptions } from './wait.ts';
