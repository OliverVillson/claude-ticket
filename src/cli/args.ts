export interface Parsed {
  positional: string[];
  flags: Record<string, string | boolean>;
}

const BOOLEAN_FLAGS = new Set([
  'plain', 'yes', 'detach', 'follow', 'json', 'projects', 'help', 'version', 'all', 'default', 'raw', 'force', 'no-color', 'quiet', 'check', 'queue', 'save', 'backlog', 'now', 'refresh', 'sandbox', 'no-sandbox', 'git', 'dry-run',
  'no-queue', 'purge', 'no-sync', 'box', 'watch', 'no-harden', 'new', 'kernel', 'no-git', 'no-push',
]);
const SHORT: Record<string, string> = { y: 'yes', f: 'follow', h: 'help', v: 'version', p: 'project', n: 'limit', c: 'concurrency', a: 'all', q: 'quiet' };

/** Minimal argv parser: positionals, `--flag`, `--flag=value`, `--flag value`, `-y`. `--` ends flags. */
export function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let onlyPositional = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (onlyPositional || a === '-' || !a.startsWith('-')) {
      positional.push(a);
      continue;
    }
    if (a === '--') {
      onlyPositional = true;
      continue;
    }
    let name: string;
    let value: string | undefined;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      value = eq > 0 ? a.slice(eq + 1) : undefined;
    } else {
      const s = a.slice(1);
      name = SHORT[s[0]!] ?? s[0]!;
      if (s.length > 1) value = s.slice(1);
    }
    if (name.startsWith('no-') && !BOOLEAN_FLAGS.has(name)) {
      flags[name.slice(3)] = false;
      continue;
    }
    if (BOOLEAN_FLAGS.has(name)) {
      flags[name] = value === undefined ? true : !/^(0|false|no)$/i.test(value);
      continue;
    }
    if (value === undefined) {
      const next = argv[i + 1];
      if (next !== undefined && (!next.startsWith('-') || /^-\d/.test(next))) {
        value = next;
        i++;
      } else {
        value = '';
      }
    }
    flags[name] = value;
  }
  return { positional, flags };
}

export function flagStr(p: Parsed, name: string): string | undefined {
  const v = p.flags[name];
  return typeof v === 'string' ? v : undefined;
}

export function flagBool(p: Parsed, name: string): boolean {
  return p.flags[name] === true;
}

export function flagNum(p: Parsed, name: string): number | undefined {
  const v = flagStr(p, name);
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
