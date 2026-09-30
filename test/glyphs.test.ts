import { describe, expect, test } from 'bun:test';
import { ASCII_GLYPHS, UNICODE_GLYPHS, glyphsFor, supportsUnicode } from '../src/ui/glyphs.ts';

// Characters with an emoji presentation that some terminals swap for a colour emoji.
const EMOJI_PRONE = /[⏩-⏺▶◀☀-➿]/u;
const ALLOWED_DINGBATS = new Set(['✓', '✗', '❯', '✢', '✶', '✻', '✽']); // not emoji, present in Menlo/DejaVu

describe('glyph table', () => {
  const all = (g: typeof UNICODE_GLYPHS) => Object.values(g).flat() as string[];
  test('unicode set avoids emoji-prone and double-width characters', () => {
    for (const s of all(UNICODE_GLYPHS))
      for (const ch of s) {
        if (!ALLOWED_DINGBATS.has(ch)) expect(ch).not.toMatch(EMOJI_PRONE);
        expect(Bun.stringWidth(ch)).toBe(1);
      }
  });
  test('ascii set is plain printable ascii, same keys', () => {
    for (const s of all(ASCII_GLYPHS)) expect(s).toMatch(/^[\x20-\x7e]+$/);
    expect(Object.keys(ASCII_GLYPHS).sort()).toEqual(Object.keys(UNICODE_GLYPHS).sort());
  });
  test('status glyphs are all different', () => {
    for (const g of [UNICODE_GLYPHS, ASCII_GLYPHS]) {
      const st = [g.todo, g.running, g.paused, g.blocked, g.failed, g.done];
      expect(new Set(st).size).toBe(st.length);
    }
  });
  test('unicode unless the locale says otherwise; SALU_ASCII overrides', () => {
    expect(supportsUnicode({})).toBe(true);
    expect(supportsUnicode({ LANG: 'en_US.UTF-8' })).toBe(true);
    expect(supportsUnicode({ LC_ALL: 'C.utf8' })).toBe(true);
    expect(supportsUnicode({ LANG: 'en_US.ISO-8859-1' })).toBe(false);
    expect(supportsUnicode({ LC_ALL: 'C', LANG: 'en_US.UTF-8' })).toBe(false);
    expect(supportsUnicode({ SALU_ASCII: '1' })).toBe(false);
    expect(supportsUnicode({ SALU_ASCII: '0', LANG: 'C' })).toBe(true);
    expect(glyphsFor({ SALU_ASCII: '1' })).toBe(ASCII_GLYPHS);
  });
});
