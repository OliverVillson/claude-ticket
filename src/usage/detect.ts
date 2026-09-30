import type { LimitHit, LimitKind, RateLimitType } from './types.ts';

/**
 * Turn what a Claude Code worker streams into a `LimitHit`.
 *
 * Signals, in order of trust (all verified against @anthropic-ai/claude-agent-sdk 0.3.285):
 *  1. `{ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt, rateLimitType } }`
 *     Emitted when the API refuses a request because a plan window is used up. `resetsAt` is unix
 *     epoch seconds. Re-emitted about every 30 s while requests keep being refused.
 *  2. An `assistant` message with `error: 'rate_limit'` (the CLI gave up retrying) whose text is
 *     Claude Code's own limit line, e.g. "You've hit your session limit · resets 3:45pm".
 *  3. A `result` message with `is_error: true` carrying the same text in `result` / `errors`.
 *
 * `system/api_retry` messages with `error: 'rate_limit'` are NOT a pause signal: the CLI is still
 * retrying, and they also fire for ordinary per-minute throttling.
 */

/**
 * Mirrors USAGE_LIMIT_ERROR_PREFIXES exported by @anthropic-ai/claude-agent-sdk 0.3.285. Copied so
 * that `ticket status` never has to load the SDK; test/usage.test.ts checks the copy against the
 * SDK export.
 */
export const LIMIT_TEXT_PREFIXES: readonly string[] = [
  "You've hit your",
  "You've reached your",
  "You're out of usage credits",
  'Your org is out of usage · add funds to continue',
  'Your org is out of usage · contact your admin',
  "Your seat type doesn't include usage credits",
  "Your seat type doesn't include usage",
  'Your usage allocation has been disabled by your admin',
  "Your group's usage limit is set to $0",
  'Fable 5 requires usage credits',
  "You're out of extra usage",
  "Your seat type doesn't include extra usage",
];

/** Labels Claude Code uses for each window in its limit line ("You've hit your <label> · resets …"). */
export const WINDOW_LABELS: Record<RateLimitType, string> = {
  five_hour: 'session limit',
  seven_day: 'weekly limit',
  seven_day_opus: 'Opus limit',
  seven_day_sonnet: 'Sonnet limit',
  seven_day_overage_included: 'Fable limit',
  overage: 'usage credit limit',
};

/** Older Claude Code builds reported the limit as `Claude AI usage limit reached|<unix seconds>`. */
const LEGACY_RE = /Claude (?:AI |Code )?usage limit reached\s*\|\s*(\d{9,13})/i;

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g;

export function kindForWindow(t: string | null | undefined): { kind: LimitHit['kind']; models: string[] } {
  switch (t) {
    case 'five_hour':
      return { kind: 'session', models: [] };
    case 'seven_day':
      return { kind: 'weekly', models: [] };
    case 'seven_day_opus':
      return { kind: 'opus', models: ['opus'] };
    case 'seven_day_sonnet':
      return { kind: 'sonnet', models: ['sonnet'] };
    case 'seven_day_overage_included':
      // The per-model weekly window for models outside the plan's base allowance; Claude Code
      // labels it "Fable limit" today. Only tickets on that model are paused.
      return { kind: 'model', models: ['fable'] };
    case 'overage':
      return { kind: 'overage', models: [] };
    default:
      return { kind: 'unknown', models: [] };
  }
}

function kindForModelName(name: string): { kind: LimitHit['kind']; models: string[] } {
  const m = name.toLowerCase();
  if (m === 'opus') return { kind: 'opus', models: ['opus'] };
  if (m === 'sonnet') return { kind: 'sonnet', models: ['sonnet'] };
  return { kind: 'model', models: [m] };
}

/**
 * Epoch milliseconds from a unix-seconds number, an epoch-ms number, an ISO string, or a
 * digits-only string. Anything else is null.
 */
export function toEpochMs(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v <= 0) return null;
    return v < 1e11 ? Math.round(v * 1000) : Math.round(v);
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (/^\d{9,13}(\.\d+)?$/.test(s)) return toEpochMs(Number(s));
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
      const t = Date.parse(s);
      return Number.isFinite(t) ? t : null;
    }
  }
  return null;
}

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const CLOCK_RE = /\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?\b|\b(\d{1,2}):(\d{2})\b/i;
const DURATION_RE = /(\d+(?:\.\d+)?)\s*(d|day|days|h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds)\b/gi;

function clockOf(s: string): { h: number; m: number } | null {
  const c = CLOCK_RE.exec(s);
  if (!c) return null;
  let h: number;
  let m: number;
  if (c[3]) {
    const raw = Number(c[1]);
    if (raw < 1 || raw > 12) return null;
    h = raw % 12;
    if (c[3].toLowerCase() === 'p') h += 12;
    m = Number(c[2] ?? 0);
  } else {
    h = Number(c[4]);
    m = Number(c[5]);
  }
  if (h > 23 || m > 59) return null;
  return { h, m };
}

function atClock(base: Date, clock: { h: number; m: number }): Date {
  const d = new Date(base);
  d.setHours(clock.h, clock.m, 0, 0);
  return d;
}

/**
 * Parse the time phrase after "resets" the way Claude Code prints it, in local time:
 * `3:45pm`, `12am`, `Mon 12:00am`, `Monday 3pm`, `tomorrow 3:45pm`, `Oct 7 12:00am`,
 * `in 2h 15m`, `in 45 minutes`, a unix timestamp or an ISO date. Returns epoch ms or null.
 */
export function parseResetPhrase(phrase: string, now: Date = new Date()): number | null {
  const s = phrase.trim().replace(/[.,;)\]]+$/, '');
  if (!s) return null;
  const direct = toEpochMs(s);
  if (direct != null) return direct;

  const rel = /^in\s+(.+)$/i.exec(s);
  if (rel) {
    let ms = 0;
    let any = false;
    for (const m of rel[1]!.matchAll(DURATION_RE)) {
      any = true;
      const n = Number(m[1]);
      const u = m[2]!.toLowerCase();
      if (u.startsWith('d')) ms += n * 86_400_000;
      else if (u.startsWith('h')) ms += n * 3_600_000;
      else if (u.startsWith('m')) ms += n * 60_000;
      else ms += n * 1000;
    }
    return any ? now.getTime() + ms : null;
  }

  const clock = clockOf(s);
  const lower = s.toLowerCase();

  if (/^tomorrow\b/.test(lower)) {
    const d = atClock(now, clock ?? { h: 0, m: 0 });
    d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  if (/^today\b/.test(lower)) {
    const d = atClock(now, clock ?? { h: 0, m: 0 });
    return d.getTime() > now.getTime() - 60_000 ? d.getTime() : d.getTime() + 86_400_000;
  }

  const day = /^(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/.exec(lower);
  if (day) {
    const target = DAY_NAMES.indexOf(day[1]!);
    const d = atClock(now, clock ?? { h: 0, m: 0 });
    let delta = (target - now.getDay() + 7) % 7;
    if (delta === 0 && d.getTime() <= now.getTime() + 60_000) delta = 7;
    d.setDate(d.getDate() + delta);
    return d.getTime();
  }

  const md = /^([a-z]{3})[a-z]*\.?\s+(\d{1,2})\b/.exec(lower);
  if (md && MONTH_NAMES.includes(md[1]!)) {
    const d = atClock(now, clock ?? { h: 0, m: 0 });
    d.setMonth(MONTH_NAMES.indexOf(md[1]!), Number(md[2]));
    if (d.getTime() < now.getTime() - 86_400_000) d.setFullYear(d.getFullYear() + 1);
    return d.getTime();
  }

  if (clock) {
    const d = atClock(now, clock);
    // Claude Code prints a bare clock time only for a reset within the next 24 hours.
    if (d.getTime() <= now.getTime() - 60_000) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  return null;
}

function classify(headline: string): { kind: LimitHit['kind']; models: string[] } {
  const h = headline.toLowerCase();
  if (/hit your session limit/.test(h)) return { kind: 'session', models: [] };
  if (/hit your weekly limit/.test(h)) return { kind: 'weekly', models: [] };
  if (/spend limit|shared budget|usage credits|extra usage|usage allocation|usage credit limit|out of usage|seat type|usage limit is set|requires usage credits/.test(h))
    return { kind: 'overage', models: [] };
  const m = /(?:hit|reached) your ([a-z0-9.-]+) limit/.exec(h);
  if (m) return kindForModelName(m[1]!);
  return { kind: 'unknown', models: [] };
}

/** Split "You've hit your session limit · resets 3:45pm · progress saved" into its parts. */
function segments(line: string): string[] {
  return line
    .split(/\s*(?:·|•|•|\s\|\s|\s-\s)\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function resetFromSegments(segs: string[], now: Date): number | null {
  for (const seg of segs) {
    const r = /^(?:resets?|resetting|resumes?)\s+(?:at\s+|on\s+)?(.+)$/i.exec(seg) ?? /^continuing automatically at\s+(.+)$/i.exec(seg);
    if (r) {
      const t = parseResetPhrase(r[1]!, now);
      if (t != null) return t;
    }
  }
  return null;
}

function indexOfPrefix(line: string): number {
  let best = -1;
  for (const p of LIMIT_TEXT_PREFIXES) {
    const i = line.indexOf(p);
    if (i >= 0 && (best < 0 || i < best)) best = i;
  }
  return best;
}

/**
 * Parse Claude Code's limit text. Returns null when the text is not a usage-limit message
 * (including "You've hit your fast limit", which is fast mode, not the plan window).
 */
export function parseLimitText(text: string | null | undefined, now: Date = new Date()): LimitHit | null {
  if (!text) return null;
  const clean = text.replace(ANSI_RE, '');
  const legacy = LEGACY_RE.exec(clean);
  if (legacy) {
    return { kind: 'session', resetsAt: toEpochMs(Number(legacy[1])), models: [], source: 'error_text', raw: legacy[0] };
  }
  for (const rawLine of clean.split(/\r?\n/)) {
    const idx = indexOfPrefix(rawLine);
    if (idx < 0) continue;
    const line = rawLine.slice(idx).trim();
    if (/^You've hit your fast limit/i.test(line)) continue;
    const segs = segments(line);
    const { kind, models } = classify(segs[0] ?? line);
    return { kind, models, resetsAt: resetFromSegments(segs, now), source: 'error_text', raw: line };
  }
  const banner = /usage limit reached(?:\s*(?:·|•)\s*continuing automatically at\s+([^·•\n]+))?/i.exec(clean);
  if (banner) {
    const phrase = banner[1]?.trim();
    return {
      kind: 'unknown',
      models: [],
      resetsAt: phrase ? parseResetPhrase(phrase, now) : null,
      source: 'error_text',
      raw: banner[0].trim(),
    };
  }
  return null;
}

function textOf(message: any): string {
  const content = message?.message?.content ?? message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => (typeof b === 'string' ? b : b?.type === 'text' ? String(b.text ?? '') : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/** A `LimitHit` from an SDK `rate_limit_info` object, or null when requests are still allowed. */
export function limitFromRateLimitInfo(info: any, now: Date = new Date()): LimitHit | null {
  if (!info || typeof info !== 'object' || info.status !== 'rejected') return null;
  // Paid extra usage covering the overflow means requests still go through.
  if (info.overageStatus === 'allowed' || info.overageStatus === 'allowed_warning') return null;
  const { kind, models } = kindForWindow(info.rateLimitType);
  const resetsAt = toEpochMs(info.resetsAt) ?? toEpochMs(info.overageResetsAt);
  const hit: LimitHit = {
    kind,
    models,
    resetsAt: resetsAt != null && resetsAt > now.getTime() - 86_400_000 ? resetsAt : null,
    source: 'rate_limit_event',
    raw: JSON.stringify(info),
  };
  if (typeof info.rateLimitType === 'string') hit.rateLimitType = info.rateLimitType as RateLimitType;
  if (typeof info.utilization === 'number') hit.utilization = info.utilization;
  return hit;
}

/**
 * Inspect one message streamed by `query()`. Non-null when the worker was refused by a usage
 * limit. Safe to call on every message; it never throws and never loads the SDK.
 */
export function detectLimit(msg: unknown, now: Date = new Date()): LimitHit | null {
  if (!msg || typeof msg !== 'object') return null;
  const m = msg as any;
  try {
    switch (m.type) {
      case 'rate_limit_event':
        return limitFromRateLimitInfo(m.rate_limit_info, now);
      case 'assistant': {
        if (m.error !== 'rate_limit' && m.error !== 'billing_error') return null;
        const text = textOf(m);
        const hit = parseLimitText(text, now);
        if (hit) return hit;
        // The CLI retries transient 429s itself; an assistant message that still ends in
        // `rate_limit` means it gave up, which on a subscription is the plan window.
        if (m.error === 'rate_limit') return { kind: 'unknown', models: [], resetsAt: null, source: 'error_text', raw: text || 'rate_limit' };
        return null;
      }
      case 'result': {
        if (!m.is_error) return null;
        const text = [m.result, ...(Array.isArray(m.errors) ? m.errors : [])].filter((s) => typeof s === 'string' && s).join('\n');
        return parseLimitText(text, now);
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** True for the SDK's "still retrying a 429" message, worth a log line but not a pause. */
export function isRateLimitRetry(msg: unknown): boolean {
  const m = msg as any;
  return !!m && m.type === 'system' && m.subtype === 'api_retry' && m.error === 'rate_limit';
}

/** Human label for a hit, e.g. "Opus limit". */
export function labelForKind(kind: LimitKind, models: string[] = []): string {
  switch (kind) {
    case 'session':
      return 'session limit';
    case 'weekly':
      return 'weekly limit';
    case 'opus':
      return 'Opus limit';
    case 'sonnet':
      return 'Sonnet limit';
    case 'model': {
      const m = models[0];
      return m ? `${m.charAt(0).toUpperCase()}${m.slice(1)} limit` : 'model limit';
    }
    case 'overage':
      return 'extra usage limit';
    case 'manual':
      return 'paused by hand';
    default:
      return 'usage limit';
  }
}
