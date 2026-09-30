import { describe, expect, test } from 'bun:test';
import { formatTags, parseTags, tokenize } from '../src/core/tags.ts';
import { parseArgs } from '../src/cli/args.ts';

describe('tokenize', () => {
  test('splits on whitespace and commas, honours quotes', () => {
    expect(tokenize('a b  c')).toEqual(['a', 'b', 'c']);
    expect(tokenize('model=opus, effort=high')).toEqual(['model=opus', 'effort=high']);
    expect(tokenize('note="hello world" bug')).toEqual(['note=hello world', 'bug']);
    expect(tokenize("x='a b'")).toEqual(['x=a b']);
    expect(tokenize('')).toEqual([]);
  });
});

describe('parseTags', () => {
  test('known keys, priority, project and labels', () => {
    const p = parseTags('model=opus effort=high priority=1 project=demo max-turns=20 permission=bypass bug docs');
    expect(p.tags).toEqual({ model: 'opus', effort: 'high', 'max-turns': '20', permission: 'bypass' });
    expect(p.priority).toBe(1);
    expect(p.project).toBe('demo');
    expect(p.labels).toEqual(['bug', 'docs']);
  });
  test('accepts an array of strings', () => {
    expect(parseTags(['model=sonnet', 'bug'])).toEqual({ tags: { model: 'sonnet' }, labels: ['bug'] });
  });
  test('custom key=value tags are kept', () => {
    expect(parseTags('team=core').tags).toEqual({ team: 'core' });
  });
  test('validates values', () => {
    expect(() => parseTags('priority=9')).toThrow(/priority/);
    expect(() => parseTags('priority=abc')).toThrow(/priority/);
    expect(() => parseTags('effort=huge')).toThrow(/effort/);
    expect(() => parseTags('permission=yolo')).toThrow(/permission/);
    expect(() => parseTags('max-turns=0')).toThrow(/max-turns/);
    expect(() => parseTags('model=')).toThrow(/no value/);
  });
  test('normalises permission spellings and model aliases', () => {
    expect(parseTags('permission=acceptedits').tags.permission).toBe('acceptEdits');
    expect(parseTags('permission=bypassPermissions').tags.permission).toBe('bypass');
    expect(parseTags('model=Opus').tags.model).toBe('opus');
    expect(parseTags('model=claude-sonnet-4-5').tags.model).toBe('claude-sonnet-4-5');
    expect(parseTags('MAX_TURNS=7').tags['max-turns']).toBe('7');
  });
  test('dedupes labels', () => {
    expect(parseTags('bug bug').labels).toEqual(['bug']);
  });
  test('formatTags round-trips', () => {
    const p = parseTags('model=opus effort=high priority=2 bug');
    const s = formatTags(p.tags, p.labels, p.priority);
    expect(s).toBe('model=opus effort=high priority=2 bug');
    expect(parseTags(s)).toEqual(p);
  });
});

describe('parseArgs', () => {
  test('positionals, long and short flags', () => {
    const p = parseArgs(['add', 'name', 'query', '--priority', '2', '--tags=model=opus x', '-y', '--plain']);
    expect(p.positional).toEqual(['add', 'name', 'query']);
    expect(p.flags).toEqual({ priority: '2', tags: 'model=opus x', yes: true, plain: true });
  });
  test('-- ends flag parsing and negative numbers are values', () => {
    expect(parseArgs(['--', '--not-a-flag']).positional).toEqual(['--not-a-flag']);
    expect(parseArgs(['--limit', '-1']).flags.limit).toBe('-1');
  });
  test('a value flag with no value becomes an empty string', () => {
    expect(parseArgs(['change', 'x', '--model']).flags.model).toBe('');
  });
});
