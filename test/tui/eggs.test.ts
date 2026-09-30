import { describe, expect, test } from 'bun:test';
import { eggDogLines, eggFor, eggFrameAt, eggFrames, eggMs, eggWords } from '../../src/tui/eggs.ts';
import { RAIN_MS, makeRain, rainCell, rainDone, rainLines } from '../../src/tui/rain.ts';
import { makeStyle } from '../../src/tui/style.ts';
import { BARK_FRAMES, SLEEP, SLEEP_WIDTH, YAWN_FRAMES } from '../../src/tui/dog/sprites.ts';
import { visibleWidth } from '../../src/tui/dog/render.ts';
import { HELP } from '../../src/cli/dispatch.ts';
import { complete } from '../../src/tui/complete.ts';

const color = makeStyle(true, 3);
const plain = makeStyle(false);

describe('which words are eggs', () => {
  test('the three words, alone, any case, salu allowed in front', () => {
    expect(eggFor('matrix')).toBe('rain');
    expect(eggFor('  MATRIX ')).toBe('rain');
    expect(eggFor('salu dojjan')).toBe('bark');
    expect(eggFor('Eskil')).toBe('yawn');
  });
  test('anything else is a normal command', () => {
    for (const line of ['', 'list', 'matrix now', 'add matrix', 'dojjans', 'salu', 'eskil eskil']) expect(eggFor(line)).toBeNull();
  });
  test('hidden: not in help and never offered by tab completion', () => {
    for (const w of ['matrix', 'dojjan', 'eskil']) {
      expect(HELP).not.toContain(w);
      expect(complete(w.slice(0, 2), { projects: [], tickets: [] }).value).not.toBe(w);
    }
  });
});

describe('dog egg frames', () => {
  test('every frame is the sleeper canvas (26 x 12 px, 15 x 4 ASCII) and keeps the body still', () => {
    const body = SLEEP[1]!.slice(7, 11);
    for (const f of [...BARK_FRAMES, ...YAWN_FRAMES]) {
      expect(f.px).toHaveLength(12);
      for (const r of f.px) expect(r).toHaveLength(SLEEP_WIDTH);
      expect(f.px.slice(7, 11)).toEqual(body);
      expect(f.ascii).toHaveLength(4);
      for (const r of f.ascii) expect(r).toHaveLength(15);
      expect(f.ms).toBeGreaterThan(0);
    }
  });
  test('dojjan barks twice and falls back asleep; eskil yawns once', () => {
    expect(BARK_FRAMES.filter((f) => f.say === 'WOOF!')).toHaveLength(2);
    expect(BARK_FRAMES.at(-1)!.say).toBeUndefined();
    expect(YAWN_FRAMES.filter((f) => f.say)).toHaveLength(1);
    // both end on the plain sleeping head (eyes shut: the D pixels of the closed eye)
    for (const k of ['bark', 'yawn'] as const) expect(eggFrames(k).at(-1)!.px[5]).toBe(SLEEP[1]![5]);
  });
  test('frames by time, ending after the total', () => {
    expect(eggFrameAt('bark', 0)).toBe(BARK_FRAMES[0]!);
    expect(eggFrameAt('bark', BARK_FRAMES[0]!.ms)).toBe(BARK_FRAMES[1]!);
    expect(eggFrameAt('bark', eggMs('bark') - 1)).toBe(BARK_FRAMES.at(-1)!);
    expect(eggFrameAt('bark', eggMs('bark'))).toBeNull();
    expect(eggFrameAt('yawn', eggMs('yawn'))).toBeNull();
    expect(eggMs('bark')).toBeLessThan(3000);
    expect(eggMs('yawn')).toBeLessThan(3000);
    expect(eggMs('rain')).toBe(RAIN_MS);
  });
  test('lines keep one width with or without words; ASCII at level 0', () => {
    for (const st of [color, plain])
      for (const f of [...BARK_FRAMES, ...YAWN_FRAMES]) {
        const lines = eggDogLines(f, st);
        expect(lines).toHaveLength(st.level ? 6 : 4);
        expect(new Set(lines.map(visibleWidth)).size).toBe(1);
        if (f.say) expect(lines[1]).toContain(f.say);
        if (!st.level) for (const l of lines) expect(l).not.toContain('\u001b');
      }
    expect(eggWords('bark')).toBe('WOOF! WOOF!');
  });
});

describe('matrix rain', () => {
  test('a full screen of lines, each exactly as wide as the terminal', () => {
    const rain = makeRain(80, 23, 42);
    for (const ms of [0, 300, 900, 1500]) {
      const lines = rainLines(rain, ms, color);
      expect(lines).toHaveLength(23);
      for (const l of lines) expect(visibleWidth(l)).toBe(80);
    }
  });
  test('it washes down: starts empty, fills, and every drop is gone by two seconds', () => {
    const rain = makeRain(120, 40, 7);
    const lit = (ms: number) => {
      let n = 0;
      for (let c = 0; c < 120; c++) for (let r = 0; r < 40; r++) if (rainCell(rain, c, r, ms)) n++;
      return n;
    };
    expect(lit(0)).toBe(0);
    expect(lit(900)).toBeGreaterThan(120 * 40 * 0.2);
    expect(rainDone(rain, 1000)).toBe(false);
    expect(rainDone(rain, RAIN_MS)).toBe(true);
    expect(lit(RAIN_MS)).toBe(0);
    // every column is crossed by its drop at some point
    for (let c = 0; c < 120; c++) expect([200, 500, 800, 1100, 1400].some((ms) => [0, 10, 20, 39].some((r) => rainCell(rain, c, r, ms)))).toBe(true);
  });
  test('the head of a drop is the brightest cell below its trail', () => {
    const rain = makeRain(10, 30, 3);
    const c = 4;
    const cells = Array.from({ length: 30 }, (_, r) => rainCell(rain, c, r, 700));
    const on = cells.map((x, r) => (x ? r : -1)).filter((r) => r >= 0);
    expect(on.length).toBeGreaterThan(0);
    expect(cells[Math.max(...on)]!.shade).toBe('head');
  });
  test('same seed, same frame; NO_COLOR and ASCII terminals get plain characters', () => {
    expect(rainLines(makeRain(40, 10, 5), 600, color)).toEqual(rainLines(makeRain(40, 10, 5), 600, color));
    const lines = rainLines(makeRain(40, 10, 5, false), 600, plain).join('');
    expect(lines).not.toContain('\u001b');
    expect(/^[\x20-\x7e]*$/.test(lines)).toBe(true);
  });
});
