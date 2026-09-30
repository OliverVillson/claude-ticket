import type { EditRow } from './components/EditList.tsx';
import { EFFORT_CHOICES, MODEL_CHOICES, PERMISSION_CHOICES, TOOLSET_CHOICES, groupSummary, labelOf, type Choice, type TagParts } from './tagGroups.ts';

export type TagGroup = 'me' | 'tools' | 'other';

export const GROUP_LABEL: Record<TagGroup, string> = { me: 'Model / effort', tools: 'Tools', other: 'Other' };

/** A value the tags already hold that is not in the list (a full model id) stays selectable. */
const withCurrent = (choices: Choice[], v: string): Choice[] => (v && !choices.some((c) => c.value === v) ? [...choices, { value: v, label: v }] : choices);

const pick = (key: string, label: string, choices: Choice[], v: string): EditRow => {
  const cs = withCurrent(choices, v);
  return { key, label, kind: 'pick', choices: cs, raw: v, value: labelOf(cs, v) };
};
const text = (key: string, label: string, v: string, placeholder: string, empty = 'none'): EditRow => ({ key, label, kind: 'text', raw: v, value: v || empty, placeholder });

export function groupRows(g: TagGroup, p: TagParts): EditRow[] {
  if (g === 'me') return [pick('model', 'model', MODEL_CHOICES, p.model), pick('effort', 'effort', EFFORT_CHOICES, p.effort)];
  if (g === 'tools') {
    const rows = [pick('toolset', 'toolset', TOOLSET_CHOICES, p.toolset)];
    if (p.toolset === 'custom') rows.push(text('tools', 'allow', p.tools, 'Read+Grep+Edit'));
    rows.push(text('deny', 'deny', p.deny, 'tools to block, e.g. Bash+WebFetch'));
    return rows;
  }
  return [
    pick('permission', 'permission', PERMISSION_CHOICES, p.permission),
    text('maxTurns', 'max-turns', p.maxTurns, 'default', 'default'),
    text('other', 'labels', p.other, 'bug area=auth  (labels and custom tags)'),
  ];
}

export function groupMenuRows(p: TagParts): EditRow[] {
  const s = groupSummary(p);
  return [
    { key: 'me', label: GROUP_LABEL.me, kind: 'menu', value: s.modelEffort },
    { key: 'tools', label: GROUP_LABEL.tools, kind: 'menu', value: s.tools },
    { key: 'other', label: GROUP_LABEL.other, kind: 'menu', value: s.other },
  ];
}

/** Apply one edit to the parts. Returns an error message when the value is not acceptable. */
export function applyTagKey(p: TagParts, key: string, raw: string): { parts: TagParts; error?: string } {
  const v = raw.trim();
  if (key === 'maxTurns' && v && !/^[1-9]\d*$/.test(v)) return { parts: p, error: 'max-turns must be a whole number' };
  if (key === 'tools' || key === 'deny') {
    if (/[=]/.test(v)) return { parts: p, error: 'list tool names separated by + or commas' };
  }
  const next = { ...p, [key]: key === 'other' ? raw : v } as TagParts;
  if (key === 'toolset' && v !== 'custom') next.tools = '';
  return { parts: next };
}
