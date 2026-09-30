import { tokenize } from './command.ts';

export const VERBS = ['add', 'remove', 'change', 'list', 'projects', 'run', 'pause', 'resume', 'stop', 'status', 'log', 'plan', 'update', 'help', 'quit'];
export const TAG_KEYS = ['project', 'model', 'effort', 'priority', 'max-turns', 'permission'];
const TAG_VALUES: Record<string, string[]> = {
  model: ['opus', 'sonnet', 'haiku'],
  effort: ['low', 'medium', 'high', 'xhigh', 'max'],
  permission: ['plan', 'default', 'acceptEdits', 'bypass'],
  priority: ['1', '2', '3', '4', '5'],
};

export interface CompleteContext {
  projects: string[];
  tickets: string[];
}

export interface Completion {
  /** the whole line after completing (unchanged when nothing matches) */
  value: string;
  /** every candidate when more than one matches */
  options: string[];
}

function commonPrefix(xs: string[]): string {
  let p = xs[0] ?? '';
  for (const x of xs) while (!x.toLowerCase().startsWith(p.toLowerCase())) p = p.slice(0, -1);
  return p;
}

const quoteIfNeeded = (s: string) => (/[\s"']/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);

/**
 * Tab completion for the command line: verbs first, then project names (after `project`,
 * `--project`, or `remove`/`change`/`list`/`run`), tag keys and their values, then ticket names.
 * Only the word under the cursor (the last one) is completed.
 */
export function complete(line: string, ctx: CompleteContext): Completion {
  const none: Completion = { value: line, options: [] };
  if (line.trim() === '') return { value: line, options: VERBS };
  let words: string[];
  try {
    words = tokenize(line);
  } catch {
    return none;
  }
  const endsSpace = /\s$/.test(line);
  const prefix = endsSpace ? '' : words.pop() ?? '';
  // Everything before the word being completed is kept verbatim.
  const head = line.slice(0, line.search(/\S*$/));
  if (words[0] === 'salu') words.shift();

  let candidates: string[] = [];
  let suffix = ' ';
  const verb = words[0];
  const prev = words[words.length - 1];
  if (words.length === 0) {
    candidates = VERBS;
  } else if (prev === '--project' || prev === '-p') {
    candidates = ctx.projects;
  } else if (/^[a-z-]+=/.test(prefix)) {
    const key = prefix.slice(0, prefix.indexOf('='));
    const vals = TAG_VALUES[key] ?? (key === 'project' ? ctx.projects : []);
    const typed = prefix.slice(key.length + 1);
    const hits = vals.filter((v) => v.toLowerCase().startsWith(typed.toLowerCase()));
    return finish(head, hits.map((v) => `${key}=${v}`), prefix, ' ', line);
  } else if (prefix.startsWith('-')) {
    candidates = [];
  } else if (['change', 'remove', 'rm', 'delete', 'edit', 'log', 'plan'].includes(verb!) && words.length === 1) {
    candidates = ctx.tickets.concat(verb === 'remove' || verb === 'change' ? ['project'] : []);
  } else if ((verb === 'remove' || verb === 'change' || verb === 'add') && words[1] === 'project' && words.length === 2) {
    candidates = ctx.projects;
  } else if (['list', 'ls', 'run'].includes(verb!) && words.length === 1) {
    candidates = ctx.projects;
  } else if (verb === 'add' && words.length === 1) {
    candidates = ['project'];
  } else if (verb === 'add' || verb === 'change') {
    const keys = TAG_KEYS.map((k) => k + '=');
    const hits = keys.filter((k) => k.startsWith(prefix.toLowerCase()));
    if (prefix && hits.length) return finish(head, hits, prefix, '', line);
    return none;
  }
  return finish(head, candidates.map(quoteIfNeeded), prefix, suffix, line);
}

function finish(head: string, cands: string[], prefix: string, suffix: string, line: string): Completion {
  const hits = cands.filter((c) => c.replace(/^"/, '').toLowerCase().startsWith(prefix.replace(/^"/, '').toLowerCase()));
  if (hits.length === 0) return { value: line, options: [] };
  if (hits.length === 1) return { value: head + hits[0] + suffix, options: [] };
  const common = commonPrefix(hits);
  return { value: head + (common.length > prefix.length ? common : prefix), options: hits };
}
