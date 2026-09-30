import { describe, expect, test } from 'bun:test';
import { groupSummary, joinTags, splitTags, toolsError, TOOLSET_CHOICES } from '../../src/tui/tagGroups.ts';
import { applyTagKey } from '../../src/tui/tagRows.ts';
import { TOOL_PRESETS } from '../../src/core/tools.ts';
import { parseTags } from '../../src/core/tags.ts';

describe('tag groups', () => {
  test('split and join round-trip and keep unknown tokens', () => {
    const s = 'model=opus effort=high tools=readonly permission=plan max-turns=30 bug area=auth';
    const p = splitTags(s);
    expect(p).toMatchObject({ model: 'opus', effort: 'high', toolset: 'readonly', permission: 'plan', maxTurns: '30', other: 'bug area=auth' });
    expect(splitTags(joinTags(p))).toEqual(p);
    expect(joinTags(p)).toBe('model=opus effort=high tools=readonly permission=plan max-turns=30 bug area=auth');
  });
  test('standard tools is the absence of a tag; presets come from core', () => {
    expect(splitTags('tools=standard').toolset).toBe('');
    expect(joinTags(splitTags('tools=standard model=sonnet'))).toBe('model=sonnet');
    for (const t of TOOL_PRESETS) if (t.name !== 'standard') expect(joinTags(splitTags(`tools=${t.name}`))).toBe(`tools=${t.name}`);
    expect(TOOLSET_CHOICES.map((c) => c.label)).toEqual([...TOOL_PRESETS.map((t) => t.name), 'custom']);
  });
  test('custom allow and deny fold into the single tools= value that core validates', () => {
    const p = splitTags('tools="allow:Read,Grep,Bash(git *);deny:Bash(rm *)"');
    expect(p).toMatchObject({ toolset: 'custom', allow: 'Read,Grep,Bash(git *)', deny: 'Bash(rm *)' });
    const tags = joinTags(p);
    expect(tags).toBe('tools="allow:Read,Grep,Bash(git *);deny:Bash(rm *)"');
    expect(parseTags(tags).tags.tools).toBe('allow:Read,Grep,Bash(git *);deny:Bash(rm *)');
    expect(joinTags({ ...p, allow: 'Read, Edit', deny: '' })).toBe('tools=allow:Read,Edit');
    expect(joinTags({ ...p, allow: '', deny: 'Bash' })).toBe('tools=deny:Bash');
    expect(joinTags({ ...p, allow: '', deny: '' })).toBe('');
    expect(joinTags(p)).not.toContain('deny-tools');
  });
  test('bad lists are reported with core wording; good ones pass', () => {
    expect(toolsError({ toolset: 'custom', allow: 'read', deny: '' })).toContain('case sensitive');
    expect(toolsError({ toolset: 'custom', allow: 'Read,,Grep', deny: '' })).toBeNull();
    expect(toolsError({ toolset: 'custom', allow: 'Read', deny: 'Bash(rm *)' })).toBeNull();
    expect(applyTagKey(splitTags('tools=allow:Read'), 'allow', 'read').error).toContain('case sensitive');
  });
  test('tags written by the early build (deny-tools=, tools=A+B) migrate to one tools= value', () => {
    expect(joinTags(splitTags('tools=readonly deny-tools=Bash+Write'))).toBe('tools=deny:Bash,Write');
    expect(joinTags(splitTags('deny-tools=Bash bug'))).toBe('tools=deny:Bash bug');
    expect(joinTags(splitTags('tools=Read+Grep+Edit'))).toBe('tools=allow:Read,Grep,Edit');
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
    expect(groupSummary(splitTags('tools=edit')).tools).toBe('edit');
    expect(groupSummary(splitTags('bug')).other).toBe('bug');
  });
});
