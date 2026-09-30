import { CliError } from './errors.ts';

/**
 * The `tools` ticket setting: which of Claude Code's tools a worker may use.
 *
 *   tools=standard                      Claude Code's regular toolset (the default)
 *   tools=readonly|edit|none            a preset (see TOOL_PRESETS)
 *   tools=allow:Read,Grep,Bash(git *)   only these tools, rules allowed without asking
 *   tools=deny:Bash(rm *)               the standard toolset minus these
 *   tools="allow:Read,Edit;deny:Bash"   both, separated by `;`
 *
 * Other modules only need `TOOL_PRESETS`, `KNOWN_TOOLS`, `validateTools`, `describeTools` and `toolsToSdk`.
 */

export const DEFAULT_TOOLS = 'standard';

/**
 * Unattended workers cannot answer permission prompts, and acceptEdits denies git. The rules ask
 * for a commit on a `salu/<name>` branch, so local git is allowed; pushing and remote or config
 * changes never are.
 */
export const DEFAULT_ALLOWED_TOOLS = [
  'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git branch:*)',
  'Bash(git checkout:*)', 'Bash(git switch:*)', 'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git stash:*)',
];
export const DEFAULT_DISALLOWED_TOOLS = ['Bash(git push:*)', 'Bash(git remote:*)', 'Bash(git config:*)'];

/** Claude Code's built-in tools, for pick-lists. Names outside this list (mcp__server__tool, newer tools) are still accepted. */
export const KNOWN_TOOLS = [
  'Read', 'Grep', 'Glob', 'Edit', 'Write', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch', 'Task', 'TodoWrite',
] as const;

export interface ToolPreset {
  name: string;
  /** one line for a pick-list */
  description: string;
  /** built-in tools available; undefined = Claude Code's standard set */
  tools?: string[];
  /** rules auto-allowed without asking; undefined = the default git rules */
  allow?: string[];
}

export const TOOL_PRESETS: readonly ToolPreset[] = [
  { name: 'standard', description: "Claude Code's regular tools (default)" },
  { name: 'readonly', description: 'read, search and browse the web; no edits, no shell', tools: ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'], allow: ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'] },
  { name: 'edit', description: 'read, search, edit files and run local git; no web, no other shell', tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'NotebookEdit', 'Bash'] },
  { name: 'none', description: 'no tools: the worker can only answer', tools: [], allow: [] },
];

export interface ToolsSpec {
  /** canonical text, as stored in the `tools` tag */
  text: string;
  preset?: string;
  allow?: string[];
  deny?: string[];
}

/** Split on commas that are not inside parentheses. */
function splitList(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function checkEntry(e: string, where: string): string {
  if (!e) throw new CliError(`tools: empty entry in ${where} (check for a stray comma)`);
  const m = /^([A-Za-z_][\w*]*)(\((.*)\))?$/.exec(e);
  if (!m) throw new CliError(`tools: "${e}" is not a tool name or a rule like Bash(git *)`);
  const name = m[1]!;
  const known = KNOWN_TOOLS.find((k) => k.toLowerCase() === name.toLowerCase());
  if (known && known !== name) throw new CliError(`tools: tool names are case sensitive, did you mean ${known}${m[2] ?? ''}?`);
  return e;
}

/** Parse and validate a tools value. Throws a CliError with a friendly message. */
export function parseTools(input: string): ToolsSpec {
  const v = input.trim();
  if (!v) throw new CliError('tools needs a value: standard, readonly, edit, none or allow:Read,Grep');
  const preset = TOOL_PRESETS.find((p) => p.name === v.toLowerCase());
  if (preset) return { text: preset.name, preset: preset.name };
  const spec: ToolsSpec = { text: '' };
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of v) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ';' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  parts.push(cur);
  if (depth !== 0) throw new CliError(`tools: unbalanced parentheses in "${v}"`);
  for (const raw of parts) {
    const part = raw.trim();
    const m = /^(allow|deny):(.*)$/i.exec(part);
    if (!m) {
      const names = TOOL_PRESETS.map((p) => p.name).join(', ');
      throw new CliError(`tools must be ${names}, or allow:Tool,Tool / deny:Tool (";" between the two), got "${v}"`);
    }
    const kind = m[1]!.toLowerCase() as 'allow' | 'deny';
    if (spec[kind]) throw new CliError(`tools: "${kind}:" given twice`);
    spec[kind] = splitList(m[2]!).map((e) => checkEntry(e, `${kind}:`));
  }
  spec.text = [spec.allow && `allow:${spec.allow.join(',')}`, spec.deny && `deny:${spec.deny.join(',')}`].filter(Boolean).join(';');
  return spec;
}

/** The canonical form of a tools value, or a CliError. */
export function validateTools(v: string): string {
  return parseTools(v).text;
}

/** One line for help, forms and `salu list`. */
export function describeTools(v: string | null | undefined): string {
  if (!v) return TOOL_PRESETS[0]!.description;
  const spec = parseTools(v);
  if (spec.preset) return TOOL_PRESETS.find((p) => p.name === spec.preset)!.description;
  const bits: string[] = [];
  if (spec.allow) bits.push(`only ${spec.allow.join(', ')}`);
  if (spec.deny) bits.push(`${spec.allow ? 'never' : 'standard tools except'} ${spec.deny.join(', ')}`);
  return bits.join('; ');
}

export interface SdkToolOptions {
  /** base set of built-in tools; absent = Claude Code's standard set */
  tools?: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
}

const uniq = (xs: string[]) => [...new Set(xs)];
const baseName = (rule: string) => rule.replace(/\(.*$/, '');

/**
 * Map a tools value onto the Agent SDK. The tool restriction and explicit `deny:` entries always
 * hold. The auto-allow rules and default git denies only apply when permission is neither `bypass`
 * (nothing is checked) nor `plan` (nothing runs), matching how workers behaved before `tools` existed.
 */
export function toolsToSdk(value: string | null | undefined, permission: string): SdkToolOptions {
  const spec = parseTools(value || DEFAULT_TOOLS);
  const preset = spec.preset ? TOOL_PRESETS.find((p) => p.name === spec.preset)! : undefined;
  const checked = permission !== 'bypass' && permission !== 'plan';
  const out: SdkToolOptions = {};
  let allow: string[] | undefined;
  if (preset) {
    if (preset.tools) out.tools = [...preset.tools];
    allow = preset.allow ?? DEFAULT_ALLOWED_TOOLS;
  } else if (spec.allow) {
    out.tools = uniq(spec.allow.map(baseName));
    allow = spec.allow;
  } else {
    allow = DEFAULT_ALLOWED_TOOLS;
  }
  if (checked) {
    out.allowedTools = [...allow];
    out.disallowedTools = uniq([...DEFAULT_DISALLOWED_TOOLS, ...(spec.deny ?? [])]);
  } else if (spec.deny) {
    out.disallowedTools = [...spec.deny];
  }
  return out;
}
