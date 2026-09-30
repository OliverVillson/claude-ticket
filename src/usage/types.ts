/**
 * Usage-window pause/resume: shared types.
 *
 * A Claude subscription (Pro/Max/Team) meters Claude Code in a rolling 5-hour window plus a
 * 7-day window, with separate weekly windows for some models. When a window is used up every
 * request is refused until it resets. This module detects that, records a pause in the `state`
 * table, and resolves when the window is open again so the orchestrator can carry on.
 */

/** Which limit closed the window. `model` is a per-model weekly window other than Opus/Sonnet. `manual` is `salu pause`. */
export type LimitKind = 'session' | 'weekly' | 'opus' | 'sonnet' | 'model' | 'overage' | 'manual' | 'unknown';

/** The SDK's own name for the window (SDKRateLimitInfo.rateLimitType), kept for logs and the status view. */
export type RateLimitType =
  | 'five_hour'
  | 'seven_day'
  | 'seven_day_opus'
  | 'seven_day_sonnet'
  | 'seven_day_overage_included'
  | 'overage';

/** Where a limit was seen. */
export type LimitSource = 'rate_limit_event' | 'error_text' | 'usage_probe' | 'manual';

/** A usage limit a worker (or the probe) ran into. */
export interface LimitHit {
  kind: Exclude<LimitKind, 'manual'>;
  /** When the window reopens, epoch milliseconds, or null when the signal carried no time. */
  resetsAt: number | null;
  /** Model prefixes this limit applies to (lower case, e.g. `opus`); empty means every model. */
  models: string[];
  source: LimitSource;
  /** The message text or event that was matched, for the log and `salu status`. */
  raw: string;
  rateLimitType?: RateLimitType;
  /** Window utilization as reported, 0..1 (may exceed 1). */
  utilization?: number;
}

/** The pause as recorded in the `state` table. */
export interface PauseState {
  kind: LimitKind;
  /** Human text for status views, e.g. "session limit". */
  reason: string;
  /** Earliest time to try again, epoch ms. 0 for a purely manual pause (indefinite). */
  until: number;
  /** Model prefixes that are paused; empty means all. */
  models: string[];
  /** True when `salu pause` was used (possibly on top of a limit pause). */
  manual: boolean;
  /** When the pause started, epoch ms. */
  since: number;
  /** How the pause was detected. */
  source: LimitSource;
  /** Probes made since the pause began that found the window still closed or were inconclusive. */
  probeAttempts: number;
  /** Inconclusive probes in a row (a closed probe resets it). Drives the give-up rule. */
  unknownProbes: number;
}

export type GateResult = { open: true } | { open: false; state: PauseState };

/** What a probe found. */
export interface ProbeResult {
  /** `open`: requests go through. `closed`: still limited (`hit` says until when). `unknown`: could not tell. */
  status: 'open' | 'closed' | 'unknown';
  hit?: LimitHit;
  /** Free text for the log. */
  detail?: string;
}

/** Why `waitUntilOpen` returned. */
export interface ResumeInfo {
  /** The pause that ended (as it was when it ended). */
  state: PauseState;
  /**
   * `probe`: a probe confirmed the window is open. `manual`: the pause was cleared elsewhere
   * (`salu resume`). `unconfirmed`: probes kept failing for reasons other than the limit, so
   * dispatch resumes anyway; a worker will re-enter the pause if the window is still closed.
   */
  confirmedBy: 'probe' | 'manual' | 'unconfirmed';
}
