import { describe, expect, test } from 'bun:test';
import { dogWidth, frameCount, renderBraille, renderDog, renderSprite, renderTrack, visibleWidth } from '../../src/tui/dog/render.ts';
import {
  ASCII_LINE_RUN, ASCII_LINE_SLEEP, ASCII_LINE_WIDTH, ASCII_RUN, ASCII_SLEEP, ASCII_WIDTH, RUN, SLEEP, SLEEP_WIDTH, TINY_RUN, TINY_SLEEP, WIDTH,
} from '../../src/tui/dog/sprites.ts';
import { Ticker } from '../../src/tui/dog/ticker.ts';
import { PALETTE } from '../../src/ui/theme.ts';

const GREENS = new Set(['accent', 'text', 'ok', 'chrome'].flatMap((r) => [PALETTE[r as 'accent'].rgb.join(';')]));
const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');

describe('dog sprites', () => {
  test('every frame in a set has the same size and only palette letters', () => {
    for (const [set, re] of [[RUN, /^[ATMD.]+$/], [SLEEP, /^[ATMDzZ.]+$/], [TINY_RUN, /^[X.]+$/], [TINY_SLEEP, /^[XzZ.]+$/]] as const) {
      const w = set[0]![0]!.length;
      const h = set[0]!.length;
      expect(h % 2).toBe(0); // two pixel rows per terminal row
      for (const f of set) {
        expect(f.length).toBe(h);
        for (const row of f) { expect(row.length).toBe(w); expect(row).toMatch(re); }
      }
    }
  });
  test('a z takes a whole cell: the other pixel of its half-block cell is empty', () => {
    for (const set of [SLEEP, TINY_SLEEP])
      for (const f of set)
        f.forEach((row, y) => [...row].forEach((c, x) => { if (c === 'z' || c === 'Z') expect(f[y ^ 1]![x]).toBe('.'); }));
  });
  test('ascii frames are one width', () => {
    for (const set of [ASCII_RUN, ASCII_SLEEP]) for (const f of set) for (const r of f) expect(r.length).toBe(ASCII_WIDTH);
    for (const s of [...ASCII_LINE_RUN, ...ASCII_LINE_SLEEP]) expect(s.length).toBe(ASCII_LINE_WIDTH);
  });
});

describe('running dog', () => {
  test('24 x 12 pixels (6 rows), four distinct frames', () => {
    expect(RUN.length).toBe(4);
    for (const f of RUN) { expect(f.length).toBe(12); expect(f[0]!.length).toBe(WIDTH); }
    expect(new Set(RUN.map((f) => f.join('\n'))).size).toBe(4);
    expect(renderDog(0, { level: 3 }).length).toBe(6);
  });
  test('reads as a dog in every frame: ear above the head, an open eye, a nose, a raised tail', () => {
    for (const f of RUN) {
      const eyeY = f.findIndex((r) => /A\.A/.test(r.slice(15)));
      expect(eyeY).toBeGreaterThan(0);
      const eyeX = f[eyeY]!.indexOf('.', 16);
      expect(f[eyeY - 1]![eyeX]).toBe('A'); // eye is a hole inside the head
      expect(f[eyeY + 1]![eyeX]).toBe('A');
      expect(f.slice(0, eyeY).join('')).toMatch(/[AD]/); // ear above the eye
      expect(f.some((r) => r.trimEnd().endsWith('D') && r.length - r.lastIndexOf('D') <= 2)).toBe(true); // nose at the snout tip
      expect(f.slice(0, 4).some((r) => /^\.?T/.test(r))).toBe(true); // tail tip, top left
    }
  });
  test('legs: near legs mid green, far legs dim, and they move between frames', () => {
    const legs = RUN.map((f) => f.slice(9).join('\n'));
    expect(new Set(legs).size).toBe(4);
    for (const l of legs) { expect(l).toContain('M'); expect(l).toContain('D'); }
  });
});

describe('sleeping dog', () => {
  test('26 x 12 pixels (6 rows): the same head with the eye shut, paws out, z and Z above', () => {
    expect(SLEEP.length).toBe(2);
    for (const f of SLEEP) {
      expect(f.length).toBe(12);
      expect(f[0]!.length).toBe(SLEEP_WIDTH);
      expect(f.join('')).toMatch(/ADDA/); // closed eye inside the head
      expect(f[f.length - 1]).toMatch(/T{6}/); // front paws on the ground
      expect(f.join('')).toContain('z');
      expect(f.join('')).toContain('Z');
    }
    expect(renderDog(0, { mode: 'sleep', level: 3 }).length).toBe(6);
  });
  test('frame 0 (the still picture) has the small z below and left of the big Z', () => {
    const at = (c: string) => { const y = SLEEP[0]!.findIndex((r) => r.includes(c)); return [SLEEP[0]![y]!.indexOf(c), y] as const; };
    const [zx, zy] = at('z');
    const [Zx, Zy] = at('Z');
    expect(zy).toBeGreaterThan(Zy);
    expect(zx).toBeLessThan(Zx);
  });
  test('the snores are letters, not pixels: z dim, Z pale', () => {
    const lines = renderDog(0, { mode: 'sleep', level: 3 });
    const top = lines.slice(0, 2).join('');
    expect(strip(top)).toMatch(/z/);
    expect(strip(top)).toMatch(/Z/);
    expect(top).toContain(`38;2;${PALETTE.text.rgb.join(';')}mZ`);
    expect(top).toContain(`38;2;${PALETTE.chrome.rgb.join(';')}mz`);
  });
  test('sleeping frames advance slowly', () => {
    expect(renderDog(7, { mode: 'sleep', level: 3 })).toEqual(renderDog(0, { mode: 'sleep', level: 3 }));
    expect(renderDog(8, { mode: 'sleep', level: 3 })).not.toEqual(renderDog(0, { mode: 'sleep', level: 3 }));
  });
});

describe('small dog', () => {
  test('is 4 pixels tall: one braille line of 6 cells, or two half-block rows for mini', () => {
    for (const f of TINY_RUN) {
      const line = renderBraille(f, 3);
      expect(visibleWidth(line)).toBe(6);
      expect(strip(line)).toMatch(/^[\u2800-\u28ff ]+$/);
    }
    expect(renderDog(0, { size: 'mini', level: 3 }).length).toBe(2);
    expect(new Set(TINY_RUN.map((f) => renderBraille(f, 3))).size).toBe(4);
  });
  test('braille dots map to the right bits, and a snore cell is a letter', () => {
    expect(strip(renderBraille(['X.', '..', '..', '..'], 3))).toBe('\u2801');
    expect(strip(renderBraille(['..', '..', '..', '.X'], 3))).toBe('\u2880');
    expect(strip(renderBraille(['XX', 'XX', 'XX', 'XX'], 3))).toBe('\u28ff');
    expect(strip(renderBraille(['..z.', '....', '....', '....'], 3))).toBe(' z');
  });
});

describe('renderDog', () => {
  test('full dog is 6 rows no wider than dogWidth at truecolor', () => {
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

import { DOG_WIDTH, dogFrame, dogLines, sleepFrame } from '../../src/tui/dog/line.ts';
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
    expect(dogFrame(1, { level: 0 })).toMatch(/^[\x20-\x7e]+$/);
    expect(dogLines(0, { level: 3 }).length).toBe(6);
  });
  test('sleepFrame is one line with a z', () => {
    expect(strip(sleepFrame({ level: 3 }))).toMatch(/^[\u2800-\u28ff ]+z ?$/);
    expect(sleepFrame({ level: 0 })).toMatch(/^[\x20-\x7e]+$/);
  });
});
