import { describe, expect, test } from 'bun:test';
import { isLimitText, limitFromSdkInfo, parseLimitText, parseResetTime, pausedUntilFor, RESUME_GRACE_MS, UNKNOWN_RESET_MS } from '../src/core/ratelimit.ts';

// A fixed "now": Wednesday 2026-09-30 14:00 local time.
const NOW = new Date(2026, 8, 30, 14, 0, 0, 0).getTime();

describe('parseResetTime', () => {
  test('later today', () => {
    const t = parseResetTime('3:45pm', NOW)!;
    const d = new Date(t);
    expect([d.getHours(), d.getMinutes(), d.getDate()]).toEqual([15, 45, 30]);
  });
  test('earlier than now rolls to tomorrow', () => {
    const d = new Date(parseResetTime('9:00am', NOW)!);
    expect([d.getHours(), d.getDate()]).toEqual([9, 1]);
  });
  test('12am and 12pm', () => {
    expect(new Date(parseResetTime('12:00am', NOW)!).getHours()).toBe(0);
    expect(new Date(parseResetTime('12pm', NOW)!).getHours()).toBe(12);
  });
  test('weekday: next Monday', () => {
    const d = new Date(parseResetTime('Mon 12:00am', NOW)!);
    expect(d.getDay()).toBe(1);
    expect(d.getTime()).toBeGreaterThan(NOW);
    expect(d.getTime() - NOW).toBeLessThan(7 * 86400_000);
  });
  test('24h clock and garbage', () => {
    expect(new Date(parseResetTime('15:45', NOW)!).getHours()).toBe(15);
    expect(parseResetTime('soon', NOW)).toBeNull();
    expect(parseResetTime('25:00', NOW)).toBeNull();
  });
});

describe('parseLimitText', () => {
  test('session limit', () => {
    const h = parseLimitText("You've hit your session limit · resets 3:45pm", NOW)!;
    expect(h.kind).toBe('session');
    expect(h.models).toEqual([]);
    expect(new Date(h.resetsAt!).getHours()).toBe(15);
  });
  test('weekly limit with weekday', () => {
    const h = parseLimitText("You've hit your weekly limit · resets Mon 12:00am", NOW)!;
    expect(h.kind).toBe('weekly');
    expect(new Date(h.resetsAt!).getDay()).toBe(1);
  });
  test('opus limit only pauses opus', () => {
    const h = parseLimitText("You've hit your Opus limit · resets 3:45pm (Europe/Berlin)", NOW)!;
    expect(h.kind).toBe('opus');
    expect(h.models).toContain('opus');
  });
  test('limit without a time', () => {
    const h = parseLimitText("Error: You've hit your session limit", NOW)!;
    expect(h.kind).toBe('session');
    expect(h.resetsAt).toBeNull();
  });
  test('legacy epoch format', () => {
    const h = parseLimitText('Claude AI usage limit reached|1790800000', NOW)!;
    expect(h.resetsAt).toBe(1790800000_000);
  });
  test('not a limit', () => {
    expect(parseLimitText('Error: ENOENT', NOW)).toBeNull();
    expect(isLimitText('all good')).toBe(false);
    expect(isLimitText("You've hit your weekly limit")).toBe(true);
  });
});

describe('limitFromSdkInfo', () => {
  test('rejected five_hour', () => {
    // limitFromSdkInfo reads the real clock and drops a reset time more than a day old, so ask for one a few hours ahead
    const resetsAt = Math.floor(Date.now() / 1000) + 3 * 3600;
    const h = limitFromSdkInfo({ status: 'rejected', rateLimitType: 'five_hour', resetsAt })!;
    expect(h.kind).toBe('session');
    expect(h.resetsAt).toBe(resetsAt * 1000);
  });
  test('rejected seven_day_opus', () => {
    expect(limitFromSdkInfo({ status: 'rejected', rateLimitType: 'seven_day_opus' })!.models).toContain('opus');
  });
  test('allowed is not a hit', () => {
    expect(limitFromSdkInfo({ status: 'allowed_warning', rateLimitType: 'five_hour' })).toBeNull();
  });
});

describe('pausedUntilFor', () => {
  test('reset time plus grace', () => {
    expect(pausedUntilFor({ kind: 'session', resetsAt: NOW + 1000, models: [], reason: '' }, NOW)).toBe(NOW + 1000 + RESUME_GRACE_MS);
  });
  test('unknown time waits ten minutes', () => {
    expect(pausedUntilFor({ kind: 'session', resetsAt: null, models: [], reason: '' }, NOW)).toBe(NOW + UNKNOWN_RESET_MS);
    expect(pausedUntilFor({ kind: 'session', resetsAt: NOW - 5, models: [], reason: '' }, NOW)).toBe(NOW + UNKNOWN_RESET_MS);
  });
});
