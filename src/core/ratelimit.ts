/**
 * Rate-limit detection for Claude Code workers: compatibility surface over `src/usage/`.
 *
 * Same names and shapes as the first cut, implemented by src/usage/detect.ts, so
 * `salu status`, `salu pause`, `salu resume` and the orchestrator keep working. New code
 * should import from '../usage/index.ts' directly (richer `LimitHit`, pause state, probe and
 * the wait loop live there).
 *
 * Signals (verified against @anthropic-ai/claude-agent-sdk 0.3.285):
 *  1. `rate_limit_event` with `rate_limit_info.status === 'rejected'` (typed; `resetsAt` is unix seconds).
 *  2. Claude Code's limit line: "You've hit your session limit · resets 3:45pm",
 *     "You've hit your weekly limit · resets Mon 12:00am", "You've hit your Opus limit · resets 3:45pm",
 *     "You're out of usage credits · resets 3:45pm", and the legacy "Claude AI usage limit reached|<unix>".
 */
import { kindForWindow, limitFromRateLimitInfo, parseLimitText as parseUsageLimitText, parseResetPhrase } from '../usage/detect.ts';
import { RESUME_MARGIN_MS, UNKNOWN_RESET_WAIT_MS } from '../usage/state.ts';
import type { LimitHit as UsageLimitHit, LimitKind as UsageLimitKind } from '../usage/types.ts';

/** `session | weekly | opus | sonnet | model | overage | unknown` (`model` = another per-model window, `overage` = spend/credit limits). */
export type LimitKind = Exclude<UsageLimitKind, 'manual'>;

export interface LimitHit {
  kind: LimitKind;
  /** epoch ms when the window resets, or null when it could not be parsed */
  resetsAt: number | null;
  /** model prefixes this limit applies to; empty means every model */
  models: string[];
  /** original text or reason, for the status view */
  reason: string;
}

export const RESUME_GRACE_MS = RESUME_MARGIN_MS; // resume one minute after the reset time
export const UNKNOWN_RESET_MS = UNKNOWN_RESET_WAIT_MS; // when the time cannot be parsed, retry in 10 minutes

/** The `src/usage` hit in this file's shape. */
export function toLegacyHit(h: UsageLimitHit): LimitHit {
  return { kind: h.kind, resetsAt: h.resetsAt, models: h.models, reason: h.raw.split('\n')[0]!.slice(0, 200) };
}

/** Does this text look like a subscription limit error at all? */
export function isLimitText(text: string | null | undefined): boolean {
  return parseUsageLimitText(text) != null;
}

/** Parse a Claude Code limit message. Returns null when the text is not a limit error. */
export function parseLimitText(text: string | null | undefined, now = Date.now()): LimitHit | null {
  const h = parseUsageLimitText(text, new Date(now));
  return h ? toLegacyHit(h) : null;
}

export function kindFromWord(w: string): LimitKind {
  w = w.toLowerCase();
  if (w === 'session' || w === 'usage' || w === '5-hour' || w === 'five_hour') return 'session';
  if (w === 'weekly' || w === 'seven_day' || w === 'week') return 'weekly';
  if (w === 'opus' || w === 'seven_day_opus') return 'opus';
  if (w === 'sonnet' || w === 'seven_day_sonnet') return 'sonnet';
  if (w === 'overage') return 'overage';
  if (w === 'seven_day_overage_included') return 'model';
  return 'unknown';
}

export function modelsForKind(kind: LimitKind): string[] {
  if (kind === 'opus') return ['opus'];
  if (kind === 'sonnet') return ['sonnet'];
  return [];
}

/**
 * Parse "3:45pm", "12:00am", "Mon 12:00am", "3pm", "15:45", "tomorrow 3:45pm", "Oct 7 12:00am",
 * "in 2h 15m", a unix timestamp or an ISO date, optionally followed by a timezone name in
 * parentheses (ignored: Claude Code prints the local time). Returns epoch ms or null.
 */
export function parseResetTime(s: string, now = Date.now(), _tz?: string): number | null {
  return parseResetPhrase(s, new Date(now));
}

/** Build a LimitHit from the SDK's typed rate-limit info (status must be `rejected`). */
export function limitFromSdkInfo(info: { status?: string; resetsAt?: number; rateLimitType?: string; [k: string]: unknown }): LimitHit | null {
  const h = limitFromRateLimitInfo(info);
  if (!h) return null;
  const legacy = toLegacyHit(h);
  legacy.reason = `${labelForKind(h.kind)} limit reached (reported by Claude Code)`;
  return legacy;
}

/** Short noun for messages of the form "<label> limit". */
export function labelForKind(kind: LimitKind | string): string {
  switch (kind) {
    case 'session':
      return '5-hour session';
    case 'weekly':
      return 'weekly';
    case 'opus':
      return 'Opus';
    case 'sonnet':
      return 'Sonnet';
    case 'model':
      return 'model';
    case 'overage':
      return 'extra usage';
    default:
      return 'usage';
  }
}

/** When the orchestrator should try again for a given hit. */
export function pausedUntilFor<T extends { resetsAt: number | null }>(hit: T, now = Date.now()): number {
  if (hit.resetsAt && hit.resetsAt > now) return hit.resetsAt + RESUME_GRACE_MS;
  return now + UNKNOWN_RESET_MS;
}

export { kindForWindow };
