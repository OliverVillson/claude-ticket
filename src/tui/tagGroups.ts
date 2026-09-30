import { EFFORTS, PERMISSIONS, tokenize } from '../core/tags.ts';

/**
 * The tag string split into the groups the form and the properties panel edit:
 * model/effort, tools, and other (permission, max-turns, free text). Pure, and tolerant: it
 * never validates (the core parser does that on save) and it keeps every token it does not know.
 */
export interface Choice {
  value: string;
  label: string;
  hint?: string;
}

export const MODEL_CHOICES: Choice[] = [
  { value: '', label: 'default', hint: 'the project or global default' },
  { value: 'opus', label: 'opus' },
  { value: 'sonnet', label: 'sonnet' },
  { value: 'haiku', label: 'haiku' },
];

export const EFFORT_CHOICES: Choice[] = [{ value: '', label: 'default', hint: 'the project or global default' }, ...EFFORTS.map((e) => ({ value: e, label: e }))];

/** `standard` is Claude Code's regular default toolset and needs no tag. */
export const TOOLSET_CHOICES: Choice[] = [
  { value: '', label: 'standard', hint: "Claude Code's regular toolset" },
  { value: 'readonly', label: 'read-only', hint: 'Read, Grep, Glob, WebFetch, WebSearch' },
  { value: 'noshell', label: 'no shell', hint: 'standard minus Bash' },
  { value: 'custom', label: 'custom list', hint: 'your own allow list' },
];

export const PERMISSION_CHOICES: Choice[] = [{ value: '', label: 'default', hint: 'acceptEdits' }, ...PERMISSIONS.map((p) => ({ value: p, label: p }))];

export const PRIORITY_CHOICES: Choice[] = [1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: `p${n}`, hint: n === 1 ? 'highest' : n === 5 ? 'lowest' : undefined }));

export const STATUS_CHOICES: Choice[] = ['todo', 'running', 'paused', 'blocked', 'failed', 'done'].map((s) => ({ value: s, label: s }));

const PRESETS = new Set(['readonly', 'noshell']);

export interface TagParts {
  model: string;
  effort: string;
  /** '' = standard, a preset name, or 'custom' (then `tools` holds the allow list) */
  toolset: string;
  /** custom allow list, names joined with + */
  tools: string;
  /** deny list, names joined with + */
  deny: string;
  permission: string;
  maxTurns: string;
  /** everything else: labels and custom key=value tags, as typed */
  other: string;
}

const quote = (t: string) => (/\s/.test(t) ? (t.includes('=') ? t.replace(/=(.*)$/, '="$1"') : `"${t}"`) : t);

export function splitTags(tags: string): TagParts {
  const p: TagParts = { model: '', effort: '', toolset: '', tools: '', deny: '', permission: '', maxTurns: '', other: '' };
  const rest: string[] = [];
  for (const tok of tokenize(tags ?? '')) {
    const eq = tok.indexOf('=');
    if (eq <= 0) {
      rest.push(quote(tok));
      continue;
    }
    const key = tok.slice(0, eq).toLowerCase().replace(/_/g, '-');
    const value = tok.slice(eq + 1);
    if (key === 'model') p.model = value;
    else if (key === 'effort') p.effort = value;
    else if (key === 'permission') p.permission = value;
    else if (key === 'max-turns' || key === 'maxturns') p.maxTurns = value;
    else if (key === 'deny-tools') p.deny = value;
    else if (key === 'tools') {
      if (value === 'standard') p.toolset = '';
      else if (PRESETS.has(value)) p.toolset = value;
      else {
        p.toolset = 'custom';
        p.tools = value;
      }
    } else rest.push(quote(tok));
  }
  p.other = rest.join(' ');
  return p;
}

/** Back to `key=value label` text. Empty settings are left out, so defaults stay implicit. */
export function joinTags(p: TagParts): string {
  const out: string[] = [];
  if (p.model) out.push(`model=${p.model}`);
  if (p.effort) out.push(`effort=${p.effort}`);
  if (p.toolset === 'custom') {
    if (p.tools.trim()) out.push(`tools=${p.tools.trim().replace(/[\s,]+/g, '+')}`);
  } else if (p.toolset) out.push(`tools=${p.toolset}`);
  if (p.deny.trim()) out.push(`deny-tools=${p.deny.trim().replace(/[\s,]+/g, '+')}`);
  if (p.permission) out.push(`permission=${p.permission}`);
  if (p.maxTurns) out.push(`max-turns=${p.maxTurns}`);
  if (p.other.trim()) out.push(p.other.trim());
  return out.join(' ');
}

export const labelOf = (choices: Choice[], value: string) => choices.find((c) => c.value === value)?.label ?? value;

/** One-line summaries shown next to each group. */
export function groupSummary(p: TagParts): { modelEffort: string; tools: string; other: string } {
  const me = [p.model ? p.model : 'default model', p.effort ? p.effort : 'default effort'].join(' · ');
  const tools = (p.toolset === 'custom' ? `custom: ${p.tools || '(none yet)'}` : labelOf(TOOLSET_CHOICES, p.toolset)) + (p.deny ? ` · deny ${p.deny}` : '');
  const other = [p.permission && `permission=${p.permission}`, p.maxTurns && `max-turns=${p.maxTurns}`, p.other].filter(Boolean).join(' ');
  return { modelEffort: me, tools, other: other || 'none' };
}
