import { describe, expect, test } from 'bun:test';
import { activityLines, idleLines, pickTarget, visibleWindow } from '../../src/tui/activity.ts';
import { makeStyle } from '../../src/tui/style.ts';
import { displayWidth } from '../../src/tui/format.ts';

const t = (id: number, status: string, updated_at: number) => ({ id, name: `t${id}`, status, updated_at }) as any;

describe('pickTarget', () => {
  const tickets = [t(1, 'running', 10), t(2, 'running', 30), t(3, 'todo', 40), t(4, 'running', 20)];
  test('pinned wins, then the selected running ticket, then the most recently updated running one', () => {
    expect(pickTarget(tickets, tickets[0], 4)!.id).toBe(4);
    expect(pickTarget(tickets, tickets[0], null)!.id).toBe(1);
    expect(pickTarget(tickets, tickets[2], null)!.id).toBe(2);
    expect(pickTarget(tickets, undefined, 99)!.id).toBe(2); // pinned ticket vanished
  });
  test('nothing running means no target', () => {
    expect(pickTarget([t(1, 'todo', 1), t(2, 'done', 2)], undefined, null)).toBeNull();
  });
});

describe('activity lines', () => {
  const st = makeStyle(false);
  test('long text wraps with an indent and every line fits', () => {
    const out = activityLines([{ kind: 'text', text: 'word '.repeat(40).trim() }, { kind: 'tool', text: 'Read(src/a.ts)' }], 40, st);
    expect(out.length).toBeGreaterThan(3);
    expect(out.every((l) => displayWidth(l) <= 40)).toBe(true);
    expect(out[0]!.startsWith('● ')).toBe(true);
    expect(out[1]!.startsWith('  ')).toBe(true);
    expect(out.at(-1)).toContain('Read(src/a.ts)');
  });
  test('errors and results are marked', () => {
    const out = activityLines([{ kind: 'error', text: 'boom' }, { kind: 'result', text: 'done · 3 turns' }], 40, st);
    expect(out[0]).toContain('✗ boom');
    expect(out[1]).toContain('✓ done');
  });
});

describe('scrollback window', () => {
  const all = Array.from({ length: 20 }, (_, i) => `l${i}`);
  test('follows the newest lines, scrolls back, and clamps', () => {
    expect(visibleWindow(all, 5, 0).lines).toEqual(['l15', 'l16', 'l17', 'l18', 'l19']);
    expect(visibleWindow(all, 5, 5).lines).toEqual(['l10', 'l11', 'l12', 'l13', 'l14']);
    expect(visibleWindow(all, 5, 999)).toEqual({ lines: ['l0', 'l1', 'l2', 'l3', 'l4'], back: 15 });
    expect(visibleWindow(all.slice(0, 3), 5, 4).lines).toEqual(['l0', 'l1', 'l2']);
  });
});

describe('idle state', () => {
  test('a dog and a line of text, centred, in any height', () => {
    const st = makeStyle(false);
    for (const h of [1, 2, 4, 9]) {
      const out = idleLines(60, h, st, 0);
      expect(out.length).toBeLessThanOrEqual(h);
      expect(out.join('\n')).toContain('no tickets running');
    }
  });
  test('tall enough shows the whole sleeping dog; shorter shows a one-line sleeper, never a cropped sprite', () => {
    const st = makeStyle(true, 3);
    const tall = idleLines(80, 14, st, 0);
    expect(tall.filter((l) => /[▀▄█]/.test(l)).length).toBeGreaterThanOrEqual(5);
    expect(tall.length).toBeGreaterThanOrEqual(9);
    const short = idleLines(80, 6, st, 0);
    expect(short.filter((l) => /[▀▄█]/.test(l)).length).toBe(0);
    expect(short.join('')).toMatch(/[\u2800-\u28ff]/);
  });
});
