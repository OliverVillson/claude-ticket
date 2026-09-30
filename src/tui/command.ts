import { stripAnsi } from '../core/ansi.ts';
import { CliError } from '../core/errors.ts';
import { setEmbedded } from '../cli/commands/_shared.ts';

/** Result of one command typed into the TUI's command line. */
export interface CommandResult {
  ok: boolean;
  /** output lines, colour codes removed (the view repaints them) */
  lines: string[];
  /** quit the app (`quit`, `exit`, `q`) */
  quit?: boolean;
  /** open the add form (`add` with nothing after it) */
  openForm?: boolean;
}

/** Split a command line the way a shell would: whitespace separates words, quotes group, `\` escapes. */
export function tokenize(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let has = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (c === '\\' && i + 1 < line.length) {
      cur += line[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (quote) throw new CliError(`unclosed ${quote} quote`);
  if (has || cur) out.push(cur);
  return out;
}

/** Commands that would take over the terminal or never return; refused with a pointer to the shell. */
function refuse(argv: string[]): string | null {
  const [verb, ...rest] = argv;
  if ((verb === 'log' || verb === 'logs') && rest.some((a) => a === '--follow' || a === '-f')) return '--follow streams forever: run `salu log "name" --follow` in a shell';
  return null;
}

/**
 * Run a command line through the same dispatcher the CLI uses, capturing what it prints.
 * A leading `salu` is optional. Handlers run in "embedded" mode: no prompts or forms of their
 * own (destructive commands need --yes), and `run` starts the orchestrator detached.
 */
export async function runCommand(line: string): Promise<CommandResult> {
  let argv: string[];
  try {
    argv = tokenize(line.trim());
  } catch (e: any) {
    return { ok: false, lines: [e.message] };
  }
  if (argv[0] === 'salu') argv.shift();
  if (argv.length === 0) return { ok: true, lines: [] };
  const verb = argv[0]!;
  if (['quit', 'exit', 'q'].includes(verb) && argv.length === 1) return { ok: true, lines: [], quit: true };
  if (verb === 'add' && argv.length === 1) return { ok: true, lines: [], openForm: true };
  const refused = refuse(argv);
  if (refused) return { ok: false, lines: [refused] };
  if (verb === 'run' && !argv.includes('--detach')) argv.push('--detach');

  const { dispatch } = await import('../cli/dispatch.ts');
  const lines: string[] = [];
  const grab = (...a: unknown[]) => {
    for (const l of stripAnsi(a.map((x) => (typeof x === 'string' ? x : Bun.inspect(x))).join(' ')).split('\n')) lines.push(l);
  };
  const saved = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  console.log = console.error = console.warn = console.info = grab as any;
  setEmbedded(true);
  let ok = true;
  try {
    const code = await dispatch(argv);
    ok = (code ?? 0) === 0;
  } catch (e: any) {
    ok = false;
    lines.push(e instanceof CliError ? `error: ${e.message}` : `error: ${String(e?.message ?? e)}`);
  } finally {
    setEmbedded(false);
    Object.assign(console, saved);
  }
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  return { ok, lines };
}
