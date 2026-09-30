import React, { useState } from 'react';
import { describe, expect, test } from 'bun:test';
import { render, Text } from 'ink';
import { BLINK_MS, blinkOn, useBlink, withWritingCursor } from '../../src/tui/blink.ts';
import { Ticker } from '../../src/tui/dog/ticker.ts';
import { TextField } from '../../src/tui/components/TextField.tsx';
import { statusBadge } from '../../src/tui/components/Status.tsx';
import { makeStyle } from '../../src/tui/style.ts';
import { displayWidth } from '../../src/tui/format.ts';
import { GLYPHS } from '../../src/ui/glyphs.ts';
import { fakeTerminal, sleep, stripAnsi } from './harness.ts';

describe('blink phase', () => {
  test('about 1 Hz on the 200 ms animation frame', () => {
    expect(BLINK_MS).toBeGreaterThanOrEqual(400);
    expect(BLINK_MS).toBeLessThanOrEqual(700);
    const seq = Array.from({ length: 11 }, (_, f) => (blinkOn(f) ? 1 : 0)).join('');
    expect(seq).toBe('11100011000'); // 0-400 ms lit, 600-1000 dark, 1200-1400 lit, …
    expect(Array.from({ length: 7 }, (_, f) => (blinkOn(f, 100) ? 1 : 0)).join('')).toBe('1111110');
  });
  test('frame 0 is lit and both halves appear in every 1.2 s of frames', () => {
    expect(blinkOn(0)).toBe(true);
    for (let start = 0; start < 100; start++) {
      const s = new Set(Array.from({ length: 6 }, (_, i) => blinkOn(start + i)));
      expect(s.size).toBe(2);
    }
  });
});

describe('useBlink', () => {
  function Probe(p: { active: boolean; k: number; ticker: Ticker }) {
    return <Text>{useBlink(p.active, p.k, p.ticker) ? 'ON' : 'off'}</Text>;
  }
  test('alternates while active, holds no timer when inactive, relights on reset', async () => {
    const ticker = new Ticker(50); // 20 ms per half period
    const term = fakeTerminal(20, 3);
    const inst = render(<Probe active k={0} ticker={ticker} />, { stdout: term.stdout, stdin: term.stdin, debug: true, patchConsole: false });
    expect(ticker.running).toBe(true);
    await term.waitFor((s) => s.includes('off'), 'dark half');
    await term.waitFor((s) => s.includes('ON'), 'lit again');
    await term.waitFor((s) => s.includes('off'), 'dark again');
    inst.rerender(<Probe active k={1} ticker={ticker} />);
    await sleep(5);
    expect(term.lastFrame()).toContain('ON'); // a keystroke relights the cursor
    inst.rerender(<Probe active={false} k={1} ticker={ticker} />);
    await sleep(5);
    expect(ticker.running).toBe(false);
    expect(term.lastFrame()).toContain('ON');
    inst.unmount();
  });
});

describe('text cursor', () => {
  test('the focused field blinks its block cursor; the text itself never changes', async () => {
    const term = fakeTerminal(40, 3);
    function Field() {
      const [v, setV] = useState('abc');
      return <TextField value={v} onChange={setV} focus width={20} />;
    }
    const inst = render(<Field />, { stdout: term.stdout, stdin: term.stdin, debug: true, patchConsole: false });
    await sleep(BLINK_MS * 2 + 200);
    const raw = term.frames.filter((f) => f.includes('abc'));
    expect(raw.some((f) => f.includes('\u001b[7m'))).toBe(true); // lit: inverse block
    expect(raw.some((f) => !f.includes('\u001b[7m'))).toBe(true); // dark: no block
    expect(new Set(raw.map((f) => stripAnsi(f).trimEnd())).size).toBe(1);
    inst.unmount();
  });
});

describe('orchestrator dot', () => {
  const on = { alive: true, workers: [{}], paused: null } as any;
  test('lit shows the on dot, dark swaps in a dim dot of the same width', () => {
    const a = stripAnsi(statusBadge(on, 0, true));
    const b = stripAnsi(statusBadge(on, 0, false));
    expect(a.startsWith(GLYPHS.on)).toBe(true);
    expect(b.startsWith(GLYPHS.dot)).toBe(true);
    expect(displayWidth(a)).toBe(displayWidth(b));
    expect(a.slice(1)).toBe(b.slice(1));
  });
  test('off and paused do not blink', () => {
    const off = { alive: false, workers: [], paused: null } as any;
    expect(statusBadge(off, 0, false)).toBe(statusBadge(off, 0, true));
  });
});

describe('writing cursor', () => {
  const st = makeStyle(true, 3);
  test('goes after the newest line when it fits, blank when dark', () => {
    const out = withWritingCursor(['one', 'two'], 20, 5, true, st, displayWidth);
    expect(stripAnsi(out[1]!)).toBe('two ' + GLYPHS.mark);
    expect(stripAnsi(withWritingCursor(['one', 'two'], 20, 5, false, st, displayWidth)[1]!)).toBe('two  ');
  });
  test('gets its own line when the last is full, keeping the height', () => {
    const full = 'x'.repeat(20);
    const out = withWritingCursor(['a', 'b', full], 20, 3, true, st, displayWidth);
    expect(out.length).toBe(3);
    expect(out.map(stripAnsi)).toEqual(['b', full, GLYPHS.mark]);
  });
  test('no colour still alternates visibly', () => {
    const plain = makeStyle(false);
    const a = withWritingCursor(['x'], 20, 3, true, plain, displayWidth)[0];
    const b = withWritingCursor(['x'], 20, 3, false, plain, displayWidth)[0];
    expect(a).not.toBe(b);
  });
});
