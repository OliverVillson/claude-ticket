import { describe, expect, test } from 'bun:test';
import { PALETTE, detectColorLevel, hex, painter, sgr } from '../src/ui/theme.ts';
import { makeStyle } from '../src/tui/style.ts';

describe('colour level detection', () => {
  test('NO_COLOR and dumb terminals turn colour off', () => {
    expect(detectColorLevel({ NO_COLOR: '1', COLORTERM: 'truecolor' }, true)).toBe(0);
    expect(detectColorLevel({ TERM: 'dumb' }, true)).toBe(0);
  });
  test('pipes are plain unless FORCE_COLOR', () => {
    expect(detectColorLevel({ COLORTERM: 'truecolor' }, false)).toBe(0);
    expect(detectColorLevel({ FORCE_COLOR: '1' }, false)).toBe(1);
    expect(detectColorLevel({ FORCE_COLOR: '0', COLORTERM: 'truecolor' }, true)).toBe(0);
  });
  test('truecolor, 256 and 16 colour terminals', () => {
    expect(detectColorLevel({ COLORTERM: 'truecolor' }, true)).toBe(3);
    expect(detectColorLevel({ TERM: 'xterm-256color' }, true)).toBe(2);
    expect(detectColorLevel({ TERM: 'xterm' }, true)).toBe(1);
  });
});

describe('palette', () => {
  test('accent is matrix green at every level', () => {
    expect(sgr('accent', 3)).toBe('38;2;0;255;65');
    expect(sgr('accent', 2)).toBe('38;5;46');
    expect(sgr('accent', 1)).toBe('92');
    expect(sgr('accent', 0)).toBeNull();
    expect(hex('accent')).toBe('#00ff41');
  });
  test('errors and warnings are red/amber, not green', () => {
    for (const r of ['error', 'warn'] as const) {
      const [rr, g, b] = PALETTE[r].rgb;
      expect(rr > g || b > g).toBe(true);
    }
  });
  test('painter is the identity without colour', () => {
    expect(painter('accent', 0)('x')).toBe('x');
    expect(painter('accent', 3)('x')).toBe('\u001b[38;2;0;255;65mx\u001b[39m');
    expect(painter('accent', 3)('')).toBe('');
  });
});

describe('tui style', () => {
  test('disabled style is plain text', () => {
    const st = makeStyle(false);
    expect(st.accent('a') + st.dim('b') + st.red('c') + st.bold('d')).toBe('abcd');
  });
  test('falls back through 256 to 16 colours', () => {
    expect(makeStyle(true, 3).accent('x')).toContain('38;2;0;255;65');
    expect(makeStyle(true, 2).accent('x')).toContain('38;5;46');
    expect(makeStyle(true, 1).accent('x')).toContain('[92m');
  });
});
