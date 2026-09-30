import { CliError } from './errors.ts';

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

export const PERMISSIONS = ['plan', 'default', 'acceptEdits', 'bypass', 'dontAsk'] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** What workers run on, and how hard they think, when neither the ticket nor its project says. */
export const DEFAULT_MODEL = 'claude-opus-5-5';
export const DEFAULT_EFFORT = 'medium';

export const MODEL_ALIASES = ['opus', 'sonnet', 'haiku'] as const;

/** Tag keys the orchestrator reads. Anything else with `key=value` is kept as a custom tag. */
export const KNOWN_KEYS = ['project', 'model', 'effort', 'priority', 'max-turns', 'permission'] as const;

export interface ParsedTags {
  /** key=value pairs (without project and priority, which are their own fields) */
  tags: Record<string, string>;
  /** bare tokens such as `bug` or `docs` */
  labels: string[];
  /** from `priority=N`, if given */
  priority?: number;
  /** from `project=name`, if given */
  project?: string;
}

/** Split a tag string on whitespace, honouring single or double quotes around values. */
export function tokenize(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let has = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (/\s/.test(ch) || ch === ',') {
      if (cur || has) out.push(cur);
      cur = '';
      has = false;
      continue;
    }
    cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}

export function validatePriority(v: string | number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 5) throw new CliError(`priority must be 1 (highest) to 5, got "${v}"`);
  return n;
}

export function validateEffort(v: string): Effort {
  if (!(EFFORTS as readonly string[]).includes(v)) throw new CliError(`effort must be one of ${EFFORTS.join(', ')}, got "${v}"`);
  return v as Effort;
}

export function validatePermission(v: string): Permission {
  const map: Record<string, Permission> = {
    plan: 'plan',
    default: 'default',
    acceptedits: 'acceptEdits',
    'accept-edits': 'acceptEdits',
    bypass: 'bypass',
    bypasspermissions: 'bypass',
    dontask: 'dontAsk',
    'dont-ask': 'dontAsk',
  };
  const p = map[v.toLowerCase()];
  if (!p) throw new CliError(`permission must be one of ${PERMISSIONS.join(', ')}, got "${v}"`);
  return p;
}

export function validateModel(v: string): string {
  if ((MODEL_ALIASES as readonly string[]).includes(v.toLowerCase())) return v.toLowerCase();
  if (/^[a-z0-9][a-z0-9.\-:/]*$/i.test(v)) return v; // full model id (claude-opus-4-1, bedrock ids, ...)
  throw new CliError(`model must be opus, sonnet, haiku or a model id, got "${v}"`);
}

export function validateMaxTurns(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new CliError(`max-turns must be a positive integer, got "${v}"`);
  return n;
}

/**
 * Parse a tag string such as `model=opus effort=high priority=1 bug` into its parts.
 * Accepts a single string or several already-split arguments.
 */
export function parseTags(input: string | string[] | undefined): ParsedTags {
  const tokens = (Array.isArray(input) ? input.flatMap(tokenize) : tokenize(input ?? '')).filter(Boolean);
  const out: ParsedTags = { tags: {}, labels: [] };
  for (const tok of tokens) {
    const eq = tok.indexOf('=');
    if (eq <= 0) {
      if (!out.labels.includes(tok)) out.labels.push(tok);
      continue;
    }
    const key = tok.slice(0, eq).trim().toLowerCase().replace(/_/g, '-');
    const value = tok.slice(eq + 1).trim();
    if (!value) throw new CliError(`tag "${key}" has no value`);
    switch (key) {
      case 'project':
        out.project = value;
        break;
      case 'priority':
        out.priority = validatePriority(value);
        break;
      case 'model':
        out.tags.model = validateModel(value);
        break;
      case 'effort':
        out.tags.effort = validateEffort(value);
        break;
      case 'permission':
        out.tags.permission = validatePermission(value);
        break;
      case 'max-turns':
      case 'maxturns':
        out.tags['max-turns'] = String(validateMaxTurns(value));
        break;
      default:
        out.tags[key] = value;
    }
  }
  return out;
}

/** Render tags and labels back into the `key=value label` form. */
export function formatTags(tags: Record<string, string>, labels: string[], priority?: number): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(tags)) parts.push(/\s/.test(v) ? `${k}="${v}"` : `${k}=${v}`);
  if (priority != null && priority !== 3) parts.push(`priority=${priority}`);
  parts.push(...labels);
  return parts.join(' ');
}
