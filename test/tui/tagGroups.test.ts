import { describe, expect, test } from 'bun:test';
import { groupSummary, joinTags, splitTags } from '../../src/tui/tagGroups.ts';
import { parseTags } from '../../src/core/tags.ts';

describe('tag groups', () => {
  test('split and join round-trip and keep unknown tokens', () => {
    const s = 'model=opus effort=high tools=readonly deny-tools=Bash+Write permission=plan max-turns=30 bug area=auth';
    const p = splitTags(s);
    expect(p).toMatchObject({ model: 'opus', effort: 'high', toolset: 'readonly', deny: 'Bash+Write', permission: 'plan', maxTurns: '30', other: 'bug area=auth' });
    expect(splitTags(joinTags(p))).toEqual(p);
    expect(joinTags(p)).toBe('model=opus effort=high tools=readonly deny-tools=Bash+Write permission=plan max-turns=30 bug area=auth');
  });
  test('standard tools is the absence of a tag; a custom list joins with +', () => {
    expect(splitTags('tools=standard').toolset).toBe('');
    expect(joinTags(splitTags('tools=standard model=sonnet'))).toBe('model=sonnet');
    const p = splitTags('tools=Read+Grep+Edit');
    expect(p).toMatchObject({ toolset: 'custom', tools: 'Read+Grep+Edit' });
    expect(joinTags({ ...p, tools: 'Read, Grep Edit' })).toBe('tools=Read+Grep+Edit');
  });
  test('what the groups write is what the CLI tag syntax parses', () => {
    const t = parseTags(joinTags({ ...splitTags(''), model: 'sonnet', effort: 'low', toolset: 'readonly', maxTurns: '12', other: 'bug' }));
    expect(t.tags.model).toBe('sonnet');
    expect(t.tags.effort).toBe('low');
    expect(t.tags.tools).toBe('readonly');
    expect(t.tags['max-turns']).toBe('12');
    expect(t.labels).toEqual(['bug']);
  });
  test('quoted values survive', () => {
    const p = splitTags('note="two words" x');
    expect(p.other).toBe('note="two words" x');
  });
  test('summaries read well', () => {
    expect(groupSummary(splitTags('')).modelEffort).toBe('default model · default effort');
    expect(groupSummary(splitTags('tools=noshell')).tools).toBe('no shell');
    expect(groupSummary(splitTags('bug')).other).toBe('bug');
  });
});
