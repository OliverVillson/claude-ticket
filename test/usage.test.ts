import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { USAGE_LIMIT_ERROR_PREFIXES } from '@anthropic-ai/claude-agent-sdk';
import { openDb } from '../src/db/db.ts';
import { STATE } from '../src/db/types.ts';
import { getState } from '../src/db/queries.ts';
import {
  clearLimitPause,
  clearManualPause,
  clearPause,
  detectLimit,
  dispatchAllowed,
  enterManualPause,
  enterPause,
  extendPause,
  fakeProbe,
  formatClock,
  formatDuration,
  formatPause,
  gateFor,
  getPause,
  interpretUsage,
  isPauseDue,
  isRateLimitRetry,
  LIMIT_TEXT_PREFIXES,
  limitFromRateLimitInfo,
  parseLimitText,
  parseResetPhrase,
  pauseCoversModel,
  probeWindow,
  resumeIfDue,
  RESUME_MARGIN_MS,
  toEpochMs,
  UNKNOWN_RESET_WAIT_MS,
  waitUntilOpen,
  type LimitHit,
  type ProbeResult,
} from '../src/usage/index.ts';

// A fixed "now": Wednesday 2026-09-30 14:00 local time.
const NOW = new Date(2026, 8, 30, 14, 0, 0, 0);
const NOW_MS = NOW.getTime();
const H = 3_600_000;

let home: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'ticket-usage-'));
  process.env.SALU_HOME = home;
});
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

function db() {
  return openDb(join(home, `t-${Math.random().toString(36).slice(2)}.db`));
}

const sessionHit = (resetsAt: number | null, extra: Partial<LimitHit> = {}): LimitHit => ({
  kind: 'session',
  models: [],
  resetsAt,
  source: 'rate_limit_event',
  raw: 'test',
  ...extra,
});

describe('prefix list mirrors the SDK', () => {
  test('LIMIT_TEXT_PREFIXES equals USAGE_LIMIT_ERROR_PREFIXES', () => {
    expect([...LIMIT_TEXT_PREFIXES]).toEqual([...USAGE_LIMIT_ERROR_PREFIXES]);
  });
});

describe('toEpochMs', () => {
  test('seconds, milliseconds, strings, ISO', () => {
    expect(toEpochMs(1790800000)).toBe(1790800000_000);
    expect(toEpochMs(1790800000_000)).toBe(1790800000_000);
    expect(toEpochMs('1790800000')).toBe(1790800000_000);
    expect(toEpochMs('2026-10-01T10:00:00Z')).toBe(Date.parse('2026-10-01T10:00:00Z'));
    expect(toEpochMs('3:45pm')).toBeNull();
    expect(toEpochMs(null)).toBeNull();
    expect(toEpochMs(0)).toBeNull();
  });
});

describe('parseResetPhrase', () => {
  const at = (s: string) => new Date(parseResetPhrase(s, NOW)!);
  test('clock later today', () => {
    const d = at('3:45pm');
    expect([d.getDate(), d.getHours(), d.getMinutes()]).toEqual([30, 15, 45]);
  });
  test('clock already past rolls to tomorrow', () => {
    const d = at('9:00am');
    expect([d.getDate(), d.getHours()]).toEqual([1, 9]);
  });
  test('12am, 12pm, 24h clock', () => {
    expect(at('12:00am').getHours()).toBe(0);
    expect(at('12pm').getHours()).toBe(12);
    expect(at('15:45').getHours()).toBe(15);
  });
  test('weekday: next Monday at midnight', () => {
    const d = at('Mon 12:00am');
    expect([d.getDay(), d.getHours(), d.getDate()]).toEqual([1, 0, 5]);
    expect(at('Monday 3pm').getDate()).toBe(5);
  });
  test('same weekday: later today stays today, earlier goes a week out', () => {
    expect(at('Wed 3:45pm').getDate()).toBe(30);
    expect(at('Wed 1:00pm').getDate()).toBe(7);
  });
  test('tomorrow, today, month day', () => {
    expect([at('tomorrow 3:45pm').getDate(), at('tomorrow 3:45pm').getHours()]).toEqual([1, 15]);
    expect(at('today 6pm').getHours()).toBe(18);
    const d = at('Oct 7 12:00am');
    expect([d.getMonth(), d.getDate(), d.getHours()]).toEqual([9, 7, 0]);
  });
  test('relative durations', () => {
    expect(parseResetPhrase('in 2h 15m', NOW)).toBe(NOW_MS + 2 * H + 15 * 60_000);
    expect(parseResetPhrase('in 45 minutes', NOW)).toBe(NOW_MS + 45 * 60_000);
    expect(parseResetPhrase('in 1 day 3 hours', NOW)).toBe(NOW_MS + 27 * H);
  });
  test('timestamps and garbage', () => {
    expect(parseResetPhrase('1790800000', NOW)).toBe(1790800000_000);
    expect(parseResetPhrase('2026-10-01T10:00:00Z', NOW)).toBe(Date.parse('2026-10-01T10:00:00Z'));
    expect(parseResetPhrase('soon', NOW)).toBeNull();
    expect(parseResetPhrase('25:00', NOW)).toBeNull();
    expect(parseResetPhrase('', NOW)).toBeNull();
  });
});

describe('parseLimitText', () => {
  test('session limit with reset', () => {
    const h = parseLimitText("You've hit your session limit · resets 3:45pm", NOW)!;
    expect(h.kind).toBe('session');
    expect(h.models).toEqual([]);
    expect(h.source).toBe('error_text');
    expect(new Date(h.resetsAt!).getHours()).toBe(15);
  });
  test('weekly limit inside an API error line with progress saved', () => {
    const h = parseLimitText("API Error: You've hit your weekly limit · resets Mon 12:00am · progress saved", NOW)!;
    expect(h.kind).toBe('weekly');
    expect(new Date(h.resetsAt!).getDay()).toBe(1);
  });
  test('Opus limit only pauses opus', () => {
    const h = parseLimitText("You've hit your Opus limit · resets 3:45pm (Europe/Berlin)", NOW)!;
    expect(h.kind).toBe('opus');
    expect(h.models).toEqual(['opus']);
    expect(new Date(h.resetsAt!).getHours()).toBe(15);
  });
  test('per-model limit for another model', () => {
    const h = parseLimitText("You've reached your Fable limit · resets Oct 7 12:00am", NOW)!;
    expect(h.kind).toBe('model');
    expect(h.models).toEqual(['fable']);
    expect(new Date(h.resetsAt!).getDate()).toBe(7);
  });
  test('credit and spend limits are overage', () => {
    expect(parseLimitText("You're out of usage credits · resets 3:45pm", NOW)!.kind).toBe('overage');
    expect(parseLimitText("You've hit your monthly spend limit · raise it at claude.ai/settings/usage", NOW)!.kind).toBe('overage');
  });
  test('limit without a time', () => {
    const h = parseLimitText("Error: You've hit your session limit", NOW)!;
    expect(h.kind).toBe('session');
    expect(h.resetsAt).toBeNull();
  });
  test('legacy epoch format', () => {
    expect(parseLimitText('Claude AI usage limit reached|1790800000', NOW)!.resetsAt).toBe(1790800000_000);
  });
  test('auto-continue banner', () => {
    const h = parseLimitText('Usage limit reached · continuing automatically at 3:45pm · esc to cancel', NOW)!;
    expect(h.kind).toBe('unknown');
    expect(new Date(h.resetsAt!).getHours()).toBe(15);
  });
  test('ANSI codes are ignored', () => {
    expect(parseLimitText("\u001b[31mYou've hit your session limit · resets 3:45pm\u001b[0m", NOW)!.kind).toBe('session');
  });
  test('fast-mode and ordinary text are not limits', () => {
    expect(parseLimitText("You've hit your fast limit · resets in 5m", NOW)).toBeNull();
    expect(parseLimitText('Error: ENOENT', NOW)).toBeNull();
    expect(parseLimitText('', NOW)).toBeNull();
    expect(parseLimitText(null, NOW)).toBeNull();
  });
});

describe('detectLimit', () => {
  test('rate_limit_event rejected (seconds → ms)', () => {
    const resetsAt = Math.floor(NOW_MS / 1000) + 3600;
    const h = detectLimit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt, utilization: 1.02 }, uuid: 'u', session_id: 's' }, NOW)!;
    expect(h.kind).toBe('session');
    expect(h.resetsAt).toBe(resetsAt * 1000);
    expect(h.source).toBe('rate_limit_event');
    expect(h.utilization).toBe(1.02);
  });
  test('rate_limit_event per-model windows', () => {
    expect(limitFromRateLimitInfo({ status: 'rejected', rateLimitType: 'seven_day_opus' })!.models).toEqual(['opus']);
    expect(limitFromRateLimitInfo({ status: 'rejected', rateLimitType: 'seven_day_sonnet' })!.kind).toBe('sonnet');
    expect(limitFromRateLimitInfo({ status: 'rejected', rateLimitType: 'seven_day' })!.kind).toBe('weekly');
  });
  test('allowed, warning, and overage-covered are not hits', () => {
    expect(detectLimit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } })).toBeNull();
    expect(detectLimit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', utilization: 0.9 } })).toBeNull();
    expect(detectLimit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', overageStatus: 'allowed' } })).toBeNull();
  });
  test('assistant message with rate_limit error and the limit line', () => {
    const h = detectLimit(
      { type: 'assistant', error: 'rate_limit', message: { content: [{ type: 'text', text: "You've hit your session limit · resets 3:45pm" }] } },
      NOW,
    )!;
    expect(h.kind).toBe('session');
    expect(new Date(h.resetsAt!).getHours()).toBe(15);
  });
  test('assistant rate_limit error without recognisable text is a low-confidence hit', () => {
    const h = detectLimit({ type: 'assistant', error: 'rate_limit', message: { content: [{ type: 'text', text: 'Request rejected (429)' }] } }, NOW)!;
    expect(h.kind).toBe('unknown');
    expect(h.resetsAt).toBeNull();
  });
  test('assistant messages without an error, and other errors, are not hits', () => {
    expect(detectLimit({ type: 'assistant', message: { content: [{ type: 'text', text: "You've hit your session limit" }] } })).toBeNull();
    expect(detectLimit({ type: 'assistant', error: 'overloaded', message: { content: [] } })).toBeNull();
  });
  test('result messages', () => {
    expect(detectLimit({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your weekly limit · resets Mon 12:00am" }, NOW)!.kind).toBe('weekly');
    expect(detectLimit({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ["You've hit your Opus limit · resets 3:45pm"] }, NOW)!.kind).toBe('opus');
    expect(detectLimit({ type: 'result', subtype: 'success', is_error: false, result: "You've hit your session limit" })).toBeNull();
    expect(detectLimit({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['max turns'] })).toBeNull();
  });
  test('api_retry is a retry, not a pause', () => {
    const m = { type: 'system', subtype: 'api_retry', error: 'rate_limit', attempt: 1, max_retries: 10, retry_delay_ms: 500 };
    expect(detectLimit(m)).toBeNull();
    expect(isRateLimitRetry(m)).toBe(true);
    expect(isRateLimitRetry({ type: 'system', subtype: 'init' })).toBe(false);
  });
  test('garbage never throws', () => {
    expect(detectLimit(null)).toBeNull();
    expect(detectLimit('x')).toBeNull();
    expect(detectLimit({ type: 'assistant', error: 'rate_limit', message: { content: 42 } })).not.toBeNull();
  });
});

describe('pause state', () => {
  test('enterPause records the limit with a margin and gateFor closes', () => {
    const d = db();
    expect(getPause(d)).toBeNull();
    expect(gateFor(d, 'opus')).toEqual({ open: true });
    const s = enterPause(d, sessionHit(NOW_MS + H), { now: NOW_MS });
    expect(s.kind).toBe('session');
    expect(s.reason).toBe('session limit');
    expect(s.until).toBe(NOW_MS + H + RESUME_MARGIN_MS);
    expect(s.models).toEqual([]);
    expect(s.manual).toBe(false);
    expect(s.since).toBe(NOW_MS);
    expect(s.source).toBe('rate_limit_event');
    expect(gateFor(d, 'opus').open).toBe(false);
    expect(gateFor(d, null).open).toBe(false);
    expect(dispatchAllowed(d, 'sonnet')).toBe(false);
    expect(getState(d, STATE.pausedUntil)).toBe(String(NOW_MS + H + RESUME_MARGIN_MS));
    expect(getState(d, STATE.pauseKind)).toBe('session');
  });
  test('no reset time waits ten minutes', () => {
    const d = db();
    expect(enterPause(d, sessionHit(null), { now: NOW_MS }).until).toBe(NOW_MS + UNKNOWN_RESET_WAIT_MS);
    expect(enterPause(db(), sessionHit(NOW_MS - 5), { now: NOW_MS }).until).toBe(NOW_MS + UNKNOWN_RESET_WAIT_MS);
  });
  test('model-specific pause lets other models through', () => {
    const d = db();
    const s = enterPause(d, { kind: 'opus', models: ['opus'], resetsAt: NOW_MS + H, source: 'error_text', raw: "You've hit your Opus limit" }, { now: NOW_MS });
    expect(s.reason).toBe('Opus limit');
    expect(gateFor(d, 'claude-opus-4-1').open).toBe(false);
    expect(gateFor(d, 'opus').open).toBe(false);
    expect(gateFor(d, 'sonnet').open).toBe(true);
    expect(gateFor(d, null).open).toBe(true);
    expect(pauseCoversModel(['opus'], 'OPUS')).toBe(true);
    expect(pauseCoversModel([], null)).toBe(true);
  });
  test('a second hit keeps the later time and widens the models', () => {
    const d = db();
    enterPause(d, { kind: 'opus', models: ['opus'], resetsAt: NOW_MS + 2 * H, source: 'error_text', raw: '' }, { now: NOW_MS });
    let s = enterPause(d, { kind: 'sonnet', models: ['sonnet'], resetsAt: NOW_MS + H, source: 'error_text', raw: '' }, { now: NOW_MS });
    expect(s.models.sort()).toEqual(['opus', 'sonnet']);
    expect(s.until).toBe(NOW_MS + 2 * H + RESUME_MARGIN_MS);
    s = enterPause(d, sessionHit(NOW_MS + H), { now: NOW_MS + 1000 });
    expect(s.models).toEqual([]);
    expect(s.kind).toBe('session');
    expect(s.until).toBe(NOW_MS + 2 * H + RESUME_MARGIN_MS);
    expect(s.since).toBe(NOW_MS);
    // narrower hit after an all-models pause changes nothing but keeps the pause
    s = enterPause(d, { kind: 'opus', models: ['opus'], resetsAt: NOW_MS + 3 * H, source: 'error_text', raw: '' }, { now: NOW_MS });
    expect(s.models).toEqual([]);
    expect(s.until).toBe(NOW_MS + 3 * H + RESUME_MARGIN_MS);
  });
  test('manual pause on its own and on top of a limit', () => {
    const d = db();
    let s = enterManualPause(d, NOW_MS);
    expect(s.kind).toBe('manual');
    expect(s.manual).toBe(true);
    expect(s.until).toBe(0);
    expect(gateFor(d, 'sonnet').open).toBe(false);
    expect(isPauseDue(s, NOW_MS + 10 * H)).toBe(false);
    clearPause(d);
    expect(getPause(d)).toBeNull();

    enterPause(d, sessionHit(NOW_MS + H), { now: NOW_MS });
    s = enterManualPause(d, NOW_MS);
    expect(s.kind).toBe('session');
    expect(s.manual).toBe(true);
    expect(s.until).toBe(NOW_MS + H + RESUME_MARGIN_MS);
    clearLimitPause(d, NOW_MS + 2 * H);
    s = getPause(d)!;
    expect(s.manual).toBe(true);
    expect(s.until).toBe(0);
    expect(s.kind).toBe('manual');
    clearManualPause(d);
    expect(getPause(d)).toBeNull();
  });
  test('extendPause counts probe attempts; isPauseDue', () => {
    const d = db();
    let s = enterPause(d, sessionHit(NOW_MS + H), { now: NOW_MS });
    expect(isPauseDue(s, NOW_MS)).toBe(false);
    expect(isPauseDue(s, s.until)).toBe(true);
    s = extendPause(d, NOW_MS + 5 * H, sessionHit(NOW_MS + 5 * H, { source: 'usage_probe' }), NOW_MS)!;
    expect(s.until).toBe(NOW_MS + 5 * H);
    expect(s.probeAttempts).toBe(1);
    expect(s.source).toBe('usage_probe');
    expect(extendPause(db(), NOW_MS + H)).toBeNull();
  });
});

describe('formatting', () => {
  test('formatDuration', () => {
    expect(formatDuration(30_000)).toBe('30s');
    expect(formatDuration(12 * 60_000)).toBe('12m');
    expect(formatDuration(H + 12 * 60_000)).toBe('1h 12m');
    expect(formatDuration(2 * 86_400_000 + 4 * H)).toBe('2d 4h');
    expect(formatDuration(-5)).toBe('0s');
  });
  test('formatPause for session, opus, weekly, manual', () => {
    const d = db();
    let s = enterPause(d, sessionHit(NOW_MS + 2 * H), { now: NOW_MS });
    expect(formatPause(s, NOW_MS)).toBe(`session limit · resumes ${formatClock(s.until)} (in 2h 1m)`);
    clearPause(d);
    s = enterPause(d, { kind: 'opus', models: ['opus'], resetsAt: NOW_MS + 3 * 86_400_000, source: 'error_text', raw: '' }, { now: NOW_MS });
    const line = formatPause(s, NOW_MS);
    expect(line.startsWith('Opus limit · Opus tickets resume Sat ')).toBe(true);
    expect(line.endsWith('(in 3d) · other models keep running')).toBe(true);
    enterManualPause(d, NOW_MS);
    expect(formatPause(getPause(d), NOW_MS).endsWith('· also paused by hand')).toBe(true);
    clearPause(d);
    expect(formatPause(enterManualPause(d, NOW_MS), NOW_MS)).toBe('paused by hand · salu resume to continue');
    expect(formatPause(null)).toBe('running');
    clearPause(d);
    s = enterPause(d, sessionHit(NOW_MS + H), { now: NOW_MS });
    expect(formatPause(s, s.until + 1)).toBe('session limit · checking whether the window is open');
  });
});

describe('interpretUsage', () => {
  const iso = (ms: number) => new Date(ms).toISOString();
  test('five-hour window exhausted → closed with its reset time', () => {
    const r = interpretUsage({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 100, resets_at: iso(NOW_MS + H) }, seven_day: { utilization: 40, resets_at: iso(NOW_MS + 3 * 86_400_000) } } }, { kind: 'session', models: [] }, NOW_MS);
    expect(r.status).toBe('closed');
    expect(r.hit!.kind).toBe('session');
    expect(r.hit!.resetsAt).toBe(NOW_MS + H);
    expect(r.hit!.source).toBe('usage_probe');
  });
  test('windows below 100% → open', () => {
    const r = interpretUsage({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 12, resets_at: iso(NOW_MS + H) }, seven_day: { utilization: 40, resets_at: null } } }, { kind: 'session', models: [] }, NOW_MS);
    expect(r.status).toBe('open');
  });
  test('exhausted window whose reset has passed → open', () => {
    const r = interpretUsage({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 100, resets_at: iso(NOW_MS - 1000) } } }, undefined, NOW_MS);
    expect(r.status).toBe('open');
  });
  test('opus pause reads the opus window; an exhausted opus window does not close a session pause', () => {
    const rl = { five_hour: { utilization: 5, resets_at: iso(NOW_MS + H) }, seven_day: { utilization: 5, resets_at: null }, seven_day_opus: { utilization: 100, resets_at: iso(NOW_MS + 2 * H) } };
    expect(interpretUsage({ rate_limits_available: true, rate_limits: rl }, { kind: 'opus', models: ['opus'] }, NOW_MS).status).toBe('closed');
    expect(interpretUsage({ rate_limits_available: true, rate_limits: rl }, { kind: 'session', models: [] }, NOW_MS).status).toBe('open');
  });
  test('model-scoped rows', () => {
    const r = interpretUsage({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 5, resets_at: null }, model_scoped: [{ display_name: 'Fable', utilization: 100, resets_at: iso(NOW_MS + H) }] } }, { kind: 'model', models: ['fable'] }, NOW_MS);
    expect(r.status).toBe('closed');
    expect(r.hit!.models).toEqual(['fable']);
  });
  test('unavailable → unknown', () => {
    expect(interpretUsage({ rate_limits_available: false, rate_limits: null }, undefined, NOW_MS).status).toBe('unknown');
    expect(interpretUsage(null, undefined, NOW_MS).status).toBe('unknown');
    expect(interpretUsage({ rate_limits_available: true, rate_limits: {} }, undefined, NOW_MS).status).toBe('unknown');
  });
});

describe('probeWindow with a stubbed SDK', () => {
  function fakeQuery(messages: any[], opts: { usage?: any } = {}) {
    const calls: any[] = [];
    const q = (args: any) => {
      calls.push(args);
      const it = (async function* () {
        if (typeof args.prompt === 'string') for (const m of messages) yield m;
      })() as any;
      it.close = () => {};
      if (opts.usage !== undefined) it.getUsage = async () => opts.usage;
      return it;
    };
    return { q, calls };
  }
  test('turn probe: open on a normal result', async () => {
    const { q, calls } = fakeQuery([{ type: 'system', subtype: 'init' }, { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }, { type: 'result', subtype: 'success', is_error: false, result: 'ok' }]);
    const r = await probeWindow({ queryFn: q, readUsage: false, cwd: home });
    expect(r.status).toBe('open');
    expect(calls[0].options.model).toBe('haiku');
    expect(calls[0].options.maxTurns).toBe(1);
    expect(calls[0].options.tools).toEqual([]);
  });
  test('turn probe: closed on a rejected rate_limit_event', async () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 600;
    const { q } = fakeQuery([{ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt } }, { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['x'] }]);
    const r = await probeWindow({ queryFn: q, readUsage: false, cwd: home });
    expect(r.status).toBe('closed');
    expect(r.hit!.resetsAt).toBe(resetsAt * 1000);
  });
  test('turn probe: unrelated error → unknown; model error retries without a model', async () => {
    const { q, calls } = fakeQuery([{ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['model haiku not found'] }]);
    const r = await probeWindow({ queryFn: q, readUsage: false, cwd: home });
    expect(r.status).toBe('unknown');
    expect(calls.length).toBe(2);
    expect(calls[1].options.model).toBeUndefined();
  });
  test('usage read answers first when available', async () => {
    const { q, calls } = fakeQuery([{ type: 'result', subtype: 'success', is_error: false, result: 'ok' }], {
      usage: { rate_limits_available: true, rate_limits: { five_hour: { utilization: 100, resets_at: new Date(Date.now() + H).toISOString() } } },
    });
    const r = await probeWindow({ queryFn: q, cwd: home, pause: { kind: 'session', models: [] } });
    expect(r.status).toBe('closed');
    expect(calls.length).toBe(1);
  });
  test('probe model follows the paused model', async () => {
    const { q, calls } = fakeQuery([{ type: 'result', subtype: 'success', is_error: false, result: 'ok' }]);
    await probeWindow({ queryFn: q, readUsage: false, cwd: home, pause: { kind: 'opus', models: ['opus'] } });
    expect(calls[0].options.model).toBe('opus');
  });
  test('a bare model (no pause) still selects the matching usage window', async () => {
    const rl = { five_hour: { utilization: 5, resets_at: null }, seven_day: { utilization: 5, resets_at: null }, seven_day_opus: { utilization: 100, resets_at: new Date(Date.now() + H).toISOString() } };
    const { q, calls } = fakeQuery([{ type: 'result', subtype: 'success', is_error: false, result: 'ok' }], { usage: { rate_limits_available: true, rate_limits: rl } });
    const closed = await probeWindow({ queryFn: q, cwd: home, model: 'opus' });
    expect(closed.status).toBe('closed');
    expect(closed.hit!.models).toEqual(['opus']);
    expect(calls.length).toBe(1);
    const open = await probeWindow({ queryFn: q, cwd: home, model: 'sonnet' });
    expect(open.status).toBe('open');
  });
  test('fake runner mode reads SALU_FAKE_LIMIT_UNTIL', () => {
    process.env.SALU_FAKE_LIMIT_UNTIL = String(Date.now() + 60_000);
    expect(fakeProbe({ pause: { kind: 'session', models: [] } }).status).toBe('closed');
    process.env.SALU_FAKE_LIMIT_UNTIL = String(Date.now() - 60_000);
    expect(fakeProbe().status).toBe('open');
    delete process.env.SALU_FAKE_LIMIT_UNTIL;
    expect(fakeProbe().status).toBe('open');
  });
});

describe('waitUntilOpen', () => {
  const quick = { pollMs: 10, margin: 0 };
  test('sleeps to the reset time, re-arms on "still closed", resumes on "open"', async () => {
    const d = db();
    const now = Date.now();
    enterPause(d, sessionHit(now + 60), { now, margin: 0 });
    const seen: number[] = [];
    let calls = 0;
    const probe = async (): Promise<ProbeResult> => {
      calls++;
      seen.push(getPause(d)!.probeAttempts);
      if (calls === 1) return { status: 'closed', hit: sessionHit(Date.now() + 40, { source: 'usage_probe' }) };
      return { status: 'open' };
    };
    const ticks: number[] = [];
    const r = await waitUntilOpen(d, { ...quick, probe, onTick: (_s, left) => ticks.push(left) });
    expect(r!.confirmedBy).toBe('probe');
    expect(r!.state.kind).toBe('session');
    expect(calls).toBe(2);
    expect(seen).toEqual([0, 1]);
    expect(ticks.length).toBeGreaterThan(0);
    expect(getPause(d)).toBeNull();
  });
  test('inconclusive probes give up after maxUnknownProbes', async () => {
    const d = db();
    const now = Date.now();
    enterPause(d, sessionHit(now + 10), { now, margin: 0 });
    let calls = 0;
    const r = await waitUntilOpen(d, { ...quick, maxUnknownProbes: 2, backoff: { unknown: () => 10 }, probe: async () => (calls++, { status: 'unknown', detail: 'network' }) });
    expect(r!.confirmedBy).toBe('unconfirmed');
    expect(calls).toBe(2);
    expect(getPause(d)).toBeNull();
  });
  test('closed probes do not count toward giving up on inconclusive ones', async () => {
    const d = db();
    const now = Date.now();
    enterPause(d, sessionHit(now + 10), { now, margin: 0 });
    const script: ProbeResult['status'][] = ['closed', 'closed', 'unknown', 'unknown', 'open'];
    let i = 0;
    const r = await waitUntilOpen(d, { ...quick, maxUnknownProbes: 3, backoff: { closed: () => 10, unknown: () => 10 }, probe: async () => ({ status: script[i++]! }) });
    expect(r!.confirmedBy).toBe('probe'); // two unknowns in a row is below the limit of three
    expect(i).toBe(5);
  });
  test('a closed probe without a time uses the closed backoff', async () => {
    const d = db();
    const now = Date.now();
    enterPause(d, sessionHit(now + 10), { now, margin: 0 });
    let calls = 0;
    const r = await waitUntilOpen(d, { ...quick, backoff: { closed: () => 15 }, probe: async () => (++calls === 1 ? { status: 'closed' } : { status: 'open' }) });
    expect(r!.confirmedBy).toBe('probe');
    expect(calls).toBe(2);
  });
  test('salu resume while waiting returns manual', async () => {
    const d = db();
    enterPause(d, sessionHit(Date.now() + 10 * H));
    setTimeout(() => clearPause(d), 40);
    const r = await waitUntilOpen(d, { ...quick, probe: async () => ({ status: 'open' }) });
    expect(r!.confirmedBy).toBe('manual');
  });
  test('manual pause is never probed away; clearing it lets the limit pause finish', async () => {
    const d = db();
    const now = Date.now();
    enterPause(d, sessionHit(now + 10), { now, margin: 0 });
    enterManualPause(d, now);
    let calls = 0;
    setTimeout(() => clearManualPause(d), 60);
    const r = await waitUntilOpen(d, { ...quick, probe: async () => (calls++, { status: 'open' }) });
    expect(r!.confirmedBy).toBe('probe');
    expect(calls).toBe(1);
    expect(getPause(d)).toBeNull();
  });
  test('the auto-resume keeps a manual pause that was added meanwhile', async () => {
    const d = db();
    const t0 = Date.now() - 10_000;
    enterPause(d, sessionHit(t0 + 1), { now: t0, margin: 0 });
    const probe = async (): Promise<ProbeResult> => {
      enterManualPause(d);
      return { status: 'open' };
    };
    const r = await resumeIfDue(d, { ...quick, probe });
    expect(r!.confirmedBy).toBe('probe');
    const s = getPause(d)!;
    expect(s.manual).toBe(true);
    expect(s.until).toBe(0);
    expect(gateFor(d, 'sonnet').open).toBe(false);
  });
  test('abort returns null and leaves the pause', async () => {
    const d = db();
    enterPause(d, sessionHit(Date.now() + 10 * H));
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    const r = await waitUntilOpen(d, { ...quick, signal: ac.signal, probe: async () => ({ status: 'open' }) });
    expect(r).toBeNull();
    expect(getPause(d)).not.toBeNull();
  });
  test('no pause returns at once', async () => {
    const r = await waitUntilOpen(db(), { ...quick, probe: async () => ({ status: 'open' }) });
    expect(r!.confirmedBy).toBe('manual');
  });
  test('resumeIfDue: nothing due → null without probing; due → probes', async () => {
    const d = db();
    let calls = 0;
    const probe = async (): Promise<ProbeResult> => (calls++, { status: 'open' });
    expect(await resumeIfDue(d, { probe })).toBeNull();
    enterPause(d, sessionHit(Date.now() + 10 * H));
    expect(await resumeIfDue(d, { probe })).toBeNull();
    expect(calls).toBe(0);
    clearPause(d);
    const t0 = Date.now() - 10_000;
    enterPause(d, sessionHit(t0 + 1), { now: t0, margin: 0 });
    const r = await resumeIfDue(d, { probe });
    expect(r!.confirmedBy).toBe('probe');
    expect(calls).toBe(1);
  });
});
