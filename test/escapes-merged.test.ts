import { describe, expect, test } from 'bun:test';
import { nameCell, oneLine } from '../src/tui/format.ts';
import { stripControl as syncStrip } from '../src/sync/format.ts';
import { stripControl, safeText } from '../src/core/ansi.ts';

describe('one control-character helper', () => {
  const evil = 'a\u001b]52;c;ZXZpbA==\u0007b‮c';
  test('list rows and one-line text never carry escapes', () => {
    expect(nameCell({ name: evil, labels: [] } as any, 20).name).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‮]/);
    expect(oneLine(evil)).toBe('abc');
  });
  test('the sync helper is the core helper', () => {
    expect(syncStrip).toBe(stripControl);
    expect(safeText(null)).toBe('');
  });
});
