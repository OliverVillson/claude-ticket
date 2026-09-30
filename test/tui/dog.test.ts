import { describe, expect, test } from 'bun:test';
import { dogWidth, frameCount, renderDog, renderSprite, renderTrack, visibleWidth } from '../../src/tui/dog/render.ts';
import { ASCII_MINI_RUN, ASCII_RUN, ASCII_SLEEP, MINI_RUN, MINI_SLEEP, RUN, SLEEP } from '../../src/tui/dog/sprites.ts';
import { Ticker } from '../../src/tui/dog/ticker.ts';
import { PALETTE } from '../../src/ui/theme.ts';

const GREENS = new Set(['accent', 'text', 'ok', 'chrome'].flatMap((r) => [PALETTE[r as 'accent'].rgb.join(';')]));

describe('dog sprites', () => {
  test('every frame in a set has the same size and only palette letters', () => {
    for (const set of [RUN, SLEEP, MINI_RUN, MINI_SLEEP]) {
      const w = set[0]![0]!.length;
      const h = set[0]!.length;
      for (const f of set) {
        expect(f.length).toBe(h);
        for (const row of f) { expect(row.length).toBe(w); expect(row).toMatch(/^[ATMD.]+$/); }
      }
    }
  });
  test('ascii frames are one width', () => {
    for (const set of [ASCII_RUN, ASCII_SLEEP]) for (const f of set) for (const r of f) expect(r.length).toBe(14);
    for (const s of ASCII_MINI_RUN) expect(s.length).toBe(5);
  });
});

describe('renderDog', () => {
  test('full dog is 6 rows of 22 cells at truecolor', () => {
    const lines = renderDog(0, { level: 3 });
    expect(lines.length).toBe(6);
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(dogWidth('full', 3));
    expect(lines.some((l) => l.includes('▀') || l.includes('▄') || l.includes('█'))).toBe(true);
  });
  test('run frames differ over a cycle and wrap', () => {
    const n = frameCount('run');
    const frames = Array.from({ length: n }, (_, t) => renderDog(t, { level: 3 }).join('\n'));
    expect(new Set(frames).size).toBe(n);
    expect(renderDog(n, { level: 3 })).toEqual(renderDog(0, { level: 3 }));
    expect(renderDog(-1, { level: 3 })).toEqual(renderDog(n - 1, { level: 3 }));
  });
  test('mini is 2 rows', () => {
    expect(renderDog(0, { size: 'mini', level: 2 }).length).toBe(2);
  });
  test('only green escapes are emitted (no other hues)', () => {
    for (const level of [3, 2, 1] as const) {
      const out = renderDog(2, { level }).join('') + renderDog(0, { level, mode: 'sleep' }).join('');
      const codes = [...out.matchAll(/\u001b\[([0-9;]+)m/g)].map((m) => m[1]!);
      for (const c of codes) {
        if (level === 3) {
          const rgb = /38;2;(\d+;\d+;\d+)/.exec(c)?.[1];
          const bg = /48;2;(\d+;\d+;\d+)/.exec(c)?.[1];
          for (const v of [rgb, bg]) if (v) expect(GREENS.has(v)).toBe(true);
        }
        if (level === 2) for (const n of c.matchAll(/[34]8;5;(\d+)/g)) expect([46, 121, 41, 29]).toContain(+n[1]!);
        if (level === 1) for (const n of c.split(';')) expect(['92', '32', '102', '42', '39', '49']).toContain(n);
      }
    }
  });
  test('level 0 is plain ascii with no escapes', () => {
    for (const size of ['full', 'mini'] as const)
      for (const mode of ['run', 'sleep'] as const) {
        const out = renderDog(3, { level: 0, size, mode }).join('\n');
        expect(out).not.toContain('\u001b');
        expect(out).not.toMatch(/[▀▄█]/);
      }
  });
  test('half blocks: top only, bottom only, both same, both different', () => {
    const [a] = renderSprite(['A.AA', '.AAT'], 1);
    expect(a).toContain('▀');
    expect(a).toContain('▄');
    expect(a).toContain('█');
    expect(a).toContain('▀'); // A over T uses fg+bg
    expect(a).toMatch(/9[0-9];10[0-9]|32;42|92;42|32;102/);
  });
});

describe('renderTrack', () => {
  test('progress moves the dog across the width', () => {
    const w = 60;
    const at = (p: number) => visibleWidth(renderTrack(0, w, p, { level: 3 })[1]!) - visibleWidth(renderDog(0, { level: 3 })[1]!.trimStart());
    expect(at(0)).toBeLessThan(at(0.5));
    expect(at(0.5)).toBeLessThan(at(1));
    for (const p of [0, 0.5, 1, 2, -1]) for (const l of renderTrack(1, w, p, { level: 3 })) expect(visibleWidth(l)).toBeLessThanOrEqual(w);
  });
});

describe('Ticker', () => {
  test('runs only while subscribed, shared by all listeners', async () => {
    const t = new Ticker(100);
    expect(t.running).toBe(false);
    const seen: number[] = [];
    const off1 = t.subscribe((n) => seen.push(n));
    const off2 = t.subscribe(() => {});
    expect(t.size).toBe(2);
    await new Promise((r) => setTimeout(r, 60));
    expect(seen.length).toBeGreaterThan(0);
    off1();
    expect(t.running).toBe(true);
    off2();
    expect(t.running).toBe(false);
  });
});

import { DOG_WIDTH, dogFrame, dogLines } from '../../src/tui/dog/line.ts';
describe('single-line api', () => {
  test('dogFrame is one line no wider than DOG_WIDTH and animates', () => {
    for (const level of [3, 2, 1] as const) {
      const fs = [0, 1, 2, 3].map((f) => dogFrame(f, { level }));
      for (const s of fs) { expect(s).not.toContain('\n'); expect(visibleWidth(s)).toBeLessThanOrEqual(DOG_WIDTH); }
      expect(new Set(fs).size).toBe(4);
      expect(dogFrame(4, { level })).toBe(fs[0]!);
    }
  });
  test('level 0 is ascii and dogLines is 6 rows', () => {
    expect(dogFrame(1, { level: 0 })).not.toContain('\u001b');
    expect(dogLines(0, { level: 3 }).length).toBe(6);
  });
});
