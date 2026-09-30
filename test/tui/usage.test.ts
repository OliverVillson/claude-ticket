import { describe, expect, test } from 'bun:test';
import { makeStyle } from '../../src/tui/style.ts';
import { percentLeft, tone, usageBar, usageText, type UsageSnapshot, type UsageWindow } from '../../src/tui/usage.ts';
import { displayWidth } from '../../src/tui/format.ts';
import { ASCII_GLYPHS, UNICODE_GLYPHS } from '../../src/ui/glyphs.ts';

const NOW = new Date(2026, 8, 30, 12, 0).getTime();
const at = (h: number, m = 0) => new Date(2026, 8, 30, h, m).getTime();
const win = (key: string, used: number | null, extra: Partial<UsageWindow> = {}): UsageWindow => ({
  id: (key === 'five_hour' ? 'session' : key) as UsageWindow['id'],
  short: key === 'five_hour' ? '5h' : 'week',
  label: key,
  percentUsed: used,
  percentLeft: used == null ? null : 100 - used,
  utilization: used == null ? null : used / 100,
  status: 'allowed',
  resetsAt: at(15, 45),
  observedAt: NOW,
  source: 'usage',
  ...extra,
});
const snap = (windows: UsageWindow[], extra: Partial<UsageSnapshot> = {}): UsageSnapshot => ({ available: true, reason: null, reasonKind: null, plan: 'max', windows, updatedAt: NOW, fetchedAt: NOW, stale: false, error: null, ...extra });
const st = makeStyle(false);
const both = snap([win('five_hour', 62), win('weekly', 28, { resetsAt: at(15, 45) + 3 * 86_400_000 })]);

describe('usage meter', () => {
  test('shows what is LEFT with a bar, the reset time and the week', () => {
    const t = usageText(both, 80, st, NOW);
    expect(t).toBe('5h ▰▰▱▱▱ 38% left · resets 3:45pm  wk ▰▰▰▰▱ 72%');
  });
  test('collapses as the room shrinks and drops out when nothing fits', () => {
    const w = (n: number) => usageText(both, n, st, NOW);
    expect(w(40)).toBe('5h ▰▰▱▱▱ 38% left · resets 3:45pm');
    expect(w(24)).toBe('5h ▰▰▱▱▱ 38% · 3:45pm');
    expect(w(14)).toBe('5h ▰▰▱▱▱ 38%');
    expect(w(6)).toBe('5h 38%');
    expect(w(3)).toBe('');
    for (const n of [80, 40, 24, 14, 6]) expect(displayWidth(w(n))).toBeLessThanOrEqual(n);
  });
  test('no data reads usage n/a; stale numbers carry a ~; unknown percent shows ?', () => {
    expect(usageText(null, 40, st, NOW)).toBe('usage n/a');
    expect(usageText(snap([], { available: false, reason: 'API key', reasonKind: 'no-subscription' }), 40, st, NOW)).toBe('usage n/a');
    expect(usageText(snap([win('five_hour', 50)], { stale: true }), 14, st, NOW)).toContain('50%~');
    expect(usageText(snap([win('five_hour', null)]), 30, st, NOW)).toContain('5h ?');
  });
  test('falls back to the weekly window when the 5-hour one is missing', () => {
    expect(usageText(snap([win('weekly', 10)]), 30, st, NOW)).toContain('wk ');
  });
  test('a rejected window without a percentage reads limit reached', () => {
    expect(usageText(snap([win('five_hour', null, { status: 'rejected' })]), 30, st, NOW)).toContain('limit reached');
  });
  test('bar cells and percent left are clamped', () => {
    expect(usageBar(0)).toBe('▱▱▱▱▱');
    expect(usageBar(100)).toBe('▰▰▰▰▰');
    expect(usageBar(3)).toBe('▰▱▱▱▱');
    expect(percentLeft(win('five_hour', 130, { percentUsed: 130 }))).toBe(0);
    expect(percentLeft(win('five_hour', -5, { percentUsed: -5 }))).toBe(100);
  });
  test('tone: greens until 30% left, amber to 10%, red below or when rejected', () => {
    expect(tone(win('five_hour', 50))).toBe('ok');
    expect(tone(win('five_hour', 75))).toBe('warn');
    expect(tone(win('five_hour', 95))).toBe('error');
    expect(tone(win('five_hour', 10, { status: 'rejected' as const }))).toBe('error');
    expect(tone(win('five_hour', 10, { status: 'warning' as const }))).toBe('warn');
  });
  test('every glyph has an ASCII form of the same width', () => {
    expect(ASCII_GLYPHS.barFull.length).toBe(UNICODE_GLYPHS.barFull.length);
    expect(ASCII_GLYPHS.barEmpty.length).toBe(1);
  });
  test('colour: only palette codes; amber and red appear only near the limit', () => {
    const c = makeStyle(true, 3);
    const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');
    const ok = usageText(snap([win('five_hour', 40)]), 60, c, NOW);
    expect(ok).not.toContain('255;176;0');
    expect(ok).not.toContain('255;85;85');
    expect(usageText(snap([win('five_hour', 80)]), 60, c, NOW)).toContain('255;176;0');
    expect(usageText(snap([win('five_hour', 97)]), 60, c, NOW)).toContain('255;85;85');
    expect(strip(ok)).toContain('60%');
  });
});
