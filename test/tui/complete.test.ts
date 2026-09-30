import { describe, expect, test } from 'bun:test';
import { complete } from '../../src/tui/complete.ts';
import { tokenize } from '../../src/tui/command.ts';

const ctx = { projects: ['web', 'api', 'wiki'], tickets: ['Fix login', 'Write docs'] };

describe('tokenize', () => {
  test('quotes, escapes and empty strings', () => {
    expect(tokenize('add "fix login" \'a b\' x\\ y ""')).toEqual(['add', 'fix login', 'a b', 'x y', '']);
    expect(() => tokenize('add "oops')).toThrow();
  });
});

describe('complete', () => {
  test('verbs', () => {
    expect(complete('ru', ctx).value).toBe('run ');
    expect(complete('salu st', ctx).options.sort()).toEqual(['status', 'stop']);
    expect(complete('', ctx).options.length).toBeGreaterThan(5);
  });
  test('project names after add project / list / --project', () => {
    expect(complete('list a', ctx).value).toBe('list api ');
    expect(complete('add "x" --project we', ctx).value).toBe('add "x" --project web ');
    expect(complete('list w', ctx).options).toEqual(['web', 'wiki']);
  });
  test('tag keys and values', () => {
    expect(complete('add "x" "q" mod', ctx).value).toBe('add "x" "q" model=');
    expect(complete('add "x" "q" effort=xh', ctx).value).toBe('add "x" "q" effort=xhigh ');
    expect(complete('add "x" "q" project=we', ctx).value).toBe('add "x" "q" project=web ');
  });
  test('ticket names are quoted when they contain spaces', () => {
    expect(complete('remove Fi', ctx).value).toBe('remove "Fix login" ');
  });
});
