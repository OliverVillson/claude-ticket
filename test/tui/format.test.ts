import { describe, expect, test } from 'bun:test';
import { ago, displayWidth, fit, fmtDuration, oneLine, padEnd, padStart, priorityText, relTime, shortModel, truncate, wrapText, modelEffort, nameCell } from '../../src/tui/format.ts';

describe('display width', () => {
  test('ascii, wide and combining characters', () => {
    expect(displayWidth('hello')).toBe(5);
    expect(displayWidth('日本語')).toBe(6);
    expect(displayWidth('é')).toBe(1); // e + combining acute
    expect(displayWidth('\u001b[31mred\u001b[39m')).toBe(3);
  });
  test('truncate cuts on cell width and adds an ellipsis', () => {
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(truncate('abc', 4)).toBe('abc');
    expect(truncate('日本語です', 5)).toBe('日本…');
    expect(truncate('abc', 0)).toBe('');
    expect(displayWidth(truncate('日本語です', 5))).toBeLessThanOrEqual(5);
  });
  test('fit pads or cuts to an exact width', () => {
    expect(fit('ab', 5)).toBe('ab   ');
    expect(fit('ab', 5, 'right')).toBe('   ab');
    expect(displayWidth(fit('a long name here', 8))).toBe(8);
    expect(padEnd('abc', 2)).toBe('abc');
    expect(padStart('abc', 2)).toBe('abc');
  });
  test('wrapText breaks on spaces and cuts long words', () => {
    expect(wrapText('one two three four', 9)).toEqual(['one two', 'three', 'four']);
    expect(wrapText('a\n\nb', 10)).toEqual(['a', '', 'b']);
    const long = wrapText('x'.repeat(25), 10);
    expect(long.length).toBe(3);
    expect(long.every((l) => displayWidth(l) <= 10)).toBe(true);
    expect(oneLine('a \n  b\tc')).toBe('a b c');
  });
});

describe('ticket formatting', () => {
  test('relative time and duration', () => {
    const now = 1_000_000_000;
    expect(relTime(now - 2_000, now)).toBe('now');
    expect(relTime(now - 45_000, now)).toBe('45s');
    expect(relTime(now - 5 * 60_000, now)).toBe('5m');
    expect(relTime(now - 3 * 3600_000, now)).toBe('3h');
    expect(relTime(now - 5 * 86400_000, now)).toBe('5d');
    expect(relTime(now - 30 * 86400_000, now)).toBe('4w');
    expect(relTime(null, now)).toBe('');
    expect(ago(now - 2_000, now)).toBe('just now');
    expect(ago(now - 5 * 60_000, now)).toBe('5m ago');
    expect(fmtDuration(45_000)).toBe('45s');
    expect(fmtDuration(80_000)).toBe('1m 20s');
    expect(fmtDuration(2 * 3600_000 + 5 * 60_000)).toBe('2h 05m');
  });
  test('priority 0 renders as now', () => {
    expect(priorityText(0)).toBe('now');
    expect(priorityText(3)).toBe('p3');
  });
  test('model names shorten', () => {
    expect(shortModel('claude-opus-4-1-20250805')).toBe('opus-4-1');
    expect(shortModel('opus')).toBe('opus');
    expect(modelEffort({ tags: JSON.stringify({ model: 'opus', effort: 'high' }) })).toBe('opus/high');
    expect(modelEffort({ tags: JSON.stringify({ effort: 'max' }) })).toBe('/max');
    expect(modelEffort({ tags: '{}' })).toBe('');
    expect(modelEffort({ tags: 'not json' })).toBe('');
  });
  test('name cell keeps the whole name and shrinks labels', () => {
    const a = nameCell({ name: 'Fix login', labels: JSON.stringify(['bug', 'auth']) }, 30);
    expect(a.name).toBe('Fix login  ');
    expect(a.labels.trim()).toBe('#bug #auth');
    expect(displayWidth(a.name + a.labels)).toBe(30);
    const b = nameCell({ name: 'A very long ticket name indeed', labels: JSON.stringify(['bug']) }, 20);
    expect(b.labels).toBe('');
    expect(displayWidth(b.name)).toBe(20);
  });
});
