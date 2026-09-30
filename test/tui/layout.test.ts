import { describe, expect, test } from 'bun:test';
import { clampCursor, computeLayout, scrollTop, viewportRows } from '../../src/tui/layout.ts';

describe('column layout', () => {
  test('wide terminals show every column and the widths add up', () => {
    const l = computeLayout(120, { showProject: true });
    expect(l.project).toBeGreaterThan(0);
    expect(l.model).toBeGreaterThan(0);
    expect(l.cost).toBeGreaterThan(0);
    const cols = [l.project, l.priority, l.model, l.status, l.age, l.cost].filter(Boolean);
    const used = 4 + cols.reduce((a, b) => a + b + 2, 0) + l.name;
    expect(used).toBe(l.total);
  });
  test('narrow terminals drop columns but keep a usable name', () => {
    for (const w of [80, 60, 50, 40, 30]) {
      const l = computeLayout(w, { showProject: true });
      expect(l.name).toBeGreaterThanOrEqual(4);
      expect(l.status).toBeGreaterThan(0);
    }
    const narrow = computeLayout(40, { showProject: true });
    expect(narrow.cost).toBe(0);
    expect(narrow.model).toBe(0);
    expect(narrow.name).toBeGreaterThanOrEqual(12);
    const tiny = computeLayout(24, { showProject: true });
    expect(tiny.project).toBe(0);
    expect(tiny.name).toBeGreaterThanOrEqual(4);
  });
});

describe('scrolling', () => {
  test('keeps the cursor inside the window', () => {
    expect(scrollTop(0, 0, 10, 100)).toBe(0);
    expect(scrollTop(0, 9, 10, 100)).toBe(0);
    expect(scrollTop(0, 10, 10, 100)).toBe(1);
    expect(scrollTop(5, 3, 10, 100)).toBe(3);
    expect(scrollTop(0, 99, 10, 100)).toBe(90);
    expect(scrollTop(50, 0, 10, 5)).toBe(0);
  });
  test('cursor and viewport clamp', () => {
    expect(clampCursor(-3, 5)).toBe(0);
    expect(clampCursor(9, 5)).toBe(4);
    expect(clampCursor(3, 0)).toBe(0);
    expect(viewportRows(30, 5)).toBe(25);
    expect(viewportRows(6, 5)).toBe(3);
    expect(viewportRows(0, 5)).toBe(19);
  });
});
