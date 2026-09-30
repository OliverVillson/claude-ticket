import { EFFORTS, PERMISSIONS, tokenize } from '../core/tags.ts';
import { TOOL_PRESETS, describeTools, parseTools, validateTools } from '../core/tools.ts';

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

/** The presets core defines (`standard` is Claude Code's regular toolset), plus a custom allow/deny list. */
export const TOOLSET_CHOICES: Choice[] = [
  ...TOOL_PRESETS.map((t) => ({ value: t.name === 'standard' ? '' : t.name, label: t.name, hint: t.description })),
  { value: 'custom', label: 'custom', hint: 'your own allow and/or deny list' },
];

export const PERMISSION_CHOICES: Choice[] = [{ value: '', label: 'default', hint: 'acceptEdits' }, ...PERMISSIONS.map((p) => ({ value: p, label: p }))];

export const PRIORITY_CHOICES: Choice[] = [1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: `p${n}`, hint: n === 1 ? 'highest' : n === 5 ? 'lowest' : undefined }));

export const STATUS_CHOICES: Choice[] = ['todo', 'running', 'paused', 'blocked', 'failed', 'done'].map((s) => ({ value: s, label: s }));

const PRESETS = new Set(TOOL_PRESETS.map((t) => t.name));

export interface TagParts {
  model: string;
  effort: string;
  /** '' = standard, a core preset name, or 'custom' (then `allow` / `deny` hold the lists) */
  toolset: string;
  /** custom allow list: comma separated tools or rules like Bash(git *) */
  allow: string;
  /** deny list, comma separated */
  deny: string;
  permission: string;
  maxTurns: string;
  /** everything else: labels and custom key=value tags, as typed */
  other: string;
}

const quote = (t: string) => (/\s/.test(t) ? (t.includes('=') ? t.replace(/=(.*)$/, '="$1"') : `"${t}"`) : t);

export function splitTags(tags: string): TagParts {
  const p: TagParts = { model: '', effort: '', toolset: '', allow: '', deny: '', permission: '', maxTurns: '', other: '' };
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
    else if (key === 'deny-tools') {
      // an early build wrote deny-tools=A+B as its own tag: fold it into the single tools value
      p.toolset = 'custom';
      p.deny = [p.deny, ...value.split(/[+,\s]+/)].filter(Boolean).join(',');
    } else if (key === 'tools') {
      if (PRESETS.has(value)) p.toolset = value === 'standard' ? '' : value;
      else {
        try {
          const spec = parseTools(value);
          p.toolset = 'custom';
          p.allow = spec.allow?.join(',') ?? '';
          p.deny = [p.deny, ...(spec.deny ?? [])].filter(Boolean).join(',');
        } catch {
          // early build: tools=Read+Grep; anything else is kept as typed
          if (/^[\w+*]+$/.test(value) && !/^(allow|deny)$/i.test(value)) {
            p.toolset = 'custom';
            p.allow = value.split('+').join(',');
          } else rest.push(quote(tok));
        }
      }
    } else rest.push(quote(tok));
  }
  p.other = rest.join(' ');
  return p;
}

/** Back to `key=value label` text. Empty settings are left out, so defaults stay implicit. */
/** The single `tools=` value core expects, or '' for the standard toolset. */
export function toolsValue(p: Pick<TagParts, 'toolset' | 'allow' | 'deny'>): string {
  if (p.toolset !== 'custom') return p.toolset;
  const list = (v: string) => v.split(/\s*,\s*/).map((x) => x.trim()).filter(Boolean).join(',');
  const a = list(p.allow);
  const d = list(p.deny);
  return [a && `allow:${a}`, d && `deny:${d}`].filter(Boolean).join(';');
}

/** An error message when the tools lists are not valid for core, else null. */
export function toolsError(p: Pick<TagParts, 'toolset' | 'allow' | 'deny'>): string | null {
  const v = toolsValue(p);
  if (!v) return null;
  try {
    validateTools(v);
    return null;
  } catch (e: any) {
    return String(e?.message ?? e).replace(/^tools:\s*/, '');
  }
}

export function joinTags(p: TagParts): string {
  const out: string[] = [];
  if (p.model) out.push(`model=${p.model}`);
  if (p.effort) out.push(`effort=${p.effort}`);
  const tools = toolsValue(p);
  if (tools) out.push(/\s/.test(tools) ? `tools="${tools}"` : `tools=${tools}`);
  if (p.permission) out.push(`permission=${p.permission}`);
  if (p.maxTurns) out.push(`max-turns=${p.maxTurns}`);
  if (p.other.trim()) out.push(p.other.trim());
  return out.join(' ');
}

export const labelOf = (choices: Choice[], value: string) => choices.find((c) => c.value === value)?.label ?? value;

/** One-line summaries shown next to each group. */
export function groupSummary(p: TagParts): { modelEffort: string; tools: string; other: string } {
  const me = [p.model ? p.model : 'default model', p.effort ? p.effort : 'default effort'].join(' · ');
  const v = toolsValue(p);
  let tools = labelOf(TOOLSET_CHOICES, p.toolset);
  if (p.toolset === 'custom') {
    try {
      tools = v ? describeTools(v) : 'custom (nothing set yet)';
    } catch {
      tools = v;
    }
  }
  const other = [p.permission && `permission=${p.permission}`, p.maxTurns && `max-turns=${p.maxTurns}`, p.other].filter(Boolean).join(' ');
  return { modelEffort: me, tools, other: other || 'none' };
}
