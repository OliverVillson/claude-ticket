import { CliError } from './errors.ts';

/**
 * The `tools` ticket setting: which of Claude Code's tools a worker may use.
 *
 *   tools=standard                      Claude Code's regular toolset (the default)
 *   tools=readonly|edit|none            a preset (see TOOL_PRESETS)
 *   tools=allow:Read,Grep,Bash(git *)   only these tools, rules allowed without asking
 *   tools=deny:Bash(rm *)               the standard toolset minus these
 *   tools=also:Bash(git clone *)        the standard toolset, and these rules allowed without asking too
 *   tools="allow:Read,Edit;deny:Bash"   clauses are separated by `;` (a preset name may come first:
 *                                       `edit;also:Bash(npm test *)`)
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
  // Read-only network git: fetching code into the project is safe (it runs nothing and sends nothing).
  'Bash(git clone:*)', 'Bash(git fetch:*)', 'Bash(git ls-remote:*)',
];
/**
 * Allowed on top of DEFAULT_ALLOWED_TOOLS while writes are confined (OS sandbox on): the whole Claude Code
 * toolset. Shell commands run inside the sandbox, so they can only change the project; the web is open by design.
 * MCP tools are not here on purpose: an MCP server runs outside the sandbox and can write anywhere, so each
 * one is allowed with `salu allow` (tools=also:mcp__server).
 */
export const CONFINED_ALLOWED_TOOLS = ['Bash', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'TodoWrite', 'Skill', 'NotebookEdit'];

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
  /** extra rules allowed without asking, on top of the base set */
  also?: string[];
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
  const m = /^([A-Za-z_][\w*.-]*)(\((.*)\))?$/.exec(e);
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
  const spec: ToolsSpec = { text: '' };
  parts.forEach((raw, i) => {
    const part = raw.trim();
    const preset = i === 0 ? TOOL_PRESETS.find((p) => p.name === part.toLowerCase()) : undefined;
    if (preset) {
      spec.preset = preset.name;
      return;
    }
    const m = /^(allow|deny|also):(.*)$/i.exec(part);
    if (!m) {
      const names = TOOL_PRESETS.map((p) => p.name).join(', ');
      throw new CliError(`tools must be ${names}, or allow:Tool,Tool / deny:Tool / also:Rule (";" between clauses), got "${v}"`);
    }
    const kind = m[1]!.toLowerCase() as 'allow' | 'deny' | 'also';
    if (spec[kind]) throw new CliError(`tools: "${kind}:" given twice`);
    spec[kind] = splitList(m[2]!).map((e) => checkEntry(e, `${kind}:`));
  });
  if (spec.preset && spec.allow) throw new CliError('tools: a preset and allow: cannot be combined (allow: lists the tools itself)');
  spec.text = [spec.preset, spec.allow && `allow:${spec.allow.join(',')}`, spec.deny && `deny:${spec.deny.join(',')}`, spec.also && `also:${spec.also.join(',')}`]
    .filter(Boolean)
    .join(';');
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
  const bits: string[] = [];
  if (spec.preset) bits.push(TOOL_PRESETS.find((p) => p.name === spec.preset)!.description);
  if (spec.allow) bits.push(`only ${spec.allow.join(', ')}`);
  if (spec.deny) bits.push(`${spec.allow || spec.preset ? 'never' : 'standard tools except'} ${spec.deny.join(', ')}`);
  if (spec.also) bits.push(`${spec.preset || spec.allow ? 'also' : 'standard tools, also'} allows ${spec.also.join(', ')}`);
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
export function toolsToSdk(value: string | null | undefined, permission: string, o: { confined?: boolean } = {}): SdkToolOptions {
  const spec = parseTools(value || DEFAULT_TOOLS);
  const preset = spec.preset ? TOOL_PRESETS.find((p) => p.name === spec.preset)! : undefined;
  const checked = permission !== 'bypass' && permission !== 'plan';
  const out: SdkToolOptions = {};
  let allow: string[] | undefined;
  if (preset) {
    if (preset.tools) out.tools = [...preset.tools];
    allow = preset.allow ?? (o.confined && !preset.tools ? [...DEFAULT_ALLOWED_TOOLS, ...CONFINED_ALLOWED_TOOLS] : DEFAULT_ALLOWED_TOOLS);
  } else if (spec.allow) {
    out.tools = uniq(spec.allow.map(baseName));
    allow = spec.allow;
  } else {
    allow = o.confined ? [...DEFAULT_ALLOWED_TOOLS, ...CONFINED_ALLOWED_TOOLS] : DEFAULT_ALLOWED_TOOLS;
  }
  if (spec.also) {
    allow = uniq([...allow, ...spec.also]);
    // A restricted tool list must contain the tool an extra rule is about (Bash for `Bash(git clone *)`).
    if (out.tools) out.tools = uniq([...out.tools, ...spec.also.map(baseName)]);
  }
  if (checked) {
    out.allowedTools = [...allow];
    out.disallowedTools = uniq([...DEFAULT_DISALLOWED_TOOLS, ...(spec.deny ?? [])]);
  } else if (spec.deny) {
    out.disallowedTools = [...spec.deny];
  }
  return out;
}

/** The rules a tools value auto-allows on top of its base set (the `also:` entries). */
export function alsoRules(value: string | null | undefined): string[] {
  return value ? (parseTools(value).also ?? []) : [];
}

/** Add `also:` rules to a tools value (missing = standard) and return the new canonical value. */
export function addAllowRules(value: string | null | undefined, rules: string[]): string {
  const spec = parseTools(value || DEFAULT_TOOLS);
  const checked = rules.map((r) => checkEntry(r.trim(), 'the rule'));
  spec.also = uniq([...(spec.also ?? []), ...checked]);
  const text = [spec.preset, spec.allow && `allow:${spec.allow.join(',')}`, spec.deny && `deny:${spec.deny.join(',')}`, `also:${spec.also.join(',')}`]
    .filter(Boolean)
    .join(';');
  return parseTools(text).text;
}

/** One tool use the worker was refused, as kept on the ticket. */
export interface Denial {
  tool: string;
  /** what it tried, short: the command, URL or path */
  input: string;
  /** the rule that would allow it */
  rule: string;
}

const MULTI_WORD = new Set(['git', 'npm', 'pnpm', 'yarn', 'bun', 'cargo', 'go', 'docker', 'kubectl', 'pip', 'pip3', 'brew', 'gh', 'make', 'deno']);

/** `Bash(<first words> *)` for each command of a shell line (split on && || ; |), deduplicated. */
export function bashRules(command: string): string[] {
  const out: string[] = [];
  for (const seg of command.split(/&&|\|\||;|\|/)) {
    const words = seg.trim().split(/\s+/).filter((w) => w && !/^[A-Za-z_]\w*=/.test(w));
    if (!words.length || words[0] === 'cd') continue;
    const head = MULTI_WORD.has(words[0]!) && words[1] && !words[1]!.startsWith('-') ? words.slice(0, 2) : words.slice(0, 1);
    out.push(`Bash(${head.join(' ')} *)`);
  }
  return uniq(out);
}

/** Turn the SDK's `permission_denials` into short records with the rule that would allow each. */
export function denialsFrom(raw: unknown): Denial[] {
  if (!Array.isArray(raw)) return [];
  const out: Denial[] = [];
  for (const d of raw) {
    const tool = String(d?.tool_name ?? '');
    if (!tool) continue;
    const input = d?.tool_input ?? {};
    if (tool === 'Bash') {
      const command = String(input.command ?? '').trim();
      const rules = bashRules(command);
      out.push({ tool, input: command.slice(0, 200), rule: rules[0] ?? 'Bash' });
      for (const r of rules.slice(1)) out.push({ tool, input: command.slice(0, 200), rule: r });
    } else {
      const what = String(input.url ?? input.file_path ?? input.path ?? input.pattern ?? input.query ?? '').slice(0, 200);
      out.push({ tool, input: what, rule: tool });
    }
  }
  const seen = new Set<string>();
  return out.filter((d) => (seen.has(d.rule) ? false : (seen.add(d.rule), true)));
}
