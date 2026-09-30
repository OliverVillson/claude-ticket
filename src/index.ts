#!/usr/bin/env bun
// Entry point. Keeps startup light: the TUI (Ink/React) and the orchestrator (Agent SDK)
// are imported lazily, so `add`, `remove`, `change`, `status` never load them.
import './core/compat.ts';
import { parseArgs } from './cli/args.ts';
import { CliError } from './core/errors.ts';
import { red } from './core/ansi.ts';

const VERSION = '0.1.0';

const HELP = `salu — a fast ticket queue for Claude Code agents

Usage   (salu ?  |  salu help  |  salu --help  shows this list; quote the ? in zsh: salu '?')
  salu add project "name" [path] [--model M] [--effort E] [--concurrency N] [--default]
  salu add "name" ["query"] ["tags"]           no project? one is made ("<name>-proj", in ./<name>-proj)
                                               tags: key=value pairs and bare labels
  salu remove "name" [--yes]                 (also: salu remove project "name")
  salu change "name" [--name N] [--query Q] [--tags T] [--priority P] [--status S]
  salu change project "name" [--path P] [--model M] [--effort E] [--concurrency N] [--default]
  salu list [project] [--plain] [--status S] [--projects] [--json]
  salu run [project] [--concurrency N] [--detach] [--plain]
  salu pause | salu resume | salu stop
  salu status [--json]
  salu log "name" [--follow] [--raw]
  salu plan "name"                           split a ticket into sub-tickets with Claude

Tags
  project=<name>  model=opus|sonnet|haiku|<id>  effort=low|medium|high|xhigh|max
  defaults: model claude-opus-5-5, effort medium (set per ticket, or per project with --model/--effort)
  priority=1..5 (1 highest, default 3)  max-turns=<n>  permission=plan|default|acceptEdits|bypass
  anything else (bug, docs, …) is a label

Run \`salu <command> --help\` for details. Data lives in ~/.salu (override with SALU_HOME).`;

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  const [verb, ...rest] = parsed.positional;
  if (parsed.flags.version) {
    console.log(`ticket ${VERSION}`);
    return 0;
  }
  if (!verb && parsed.flags.help) {
    console.log(HELP);
    return 0;
  }
  const sub = { ...parsed, positional: rest };
  switch (verb) {
    case undefined:
    case 'list':
    case 'ls':
      return (await import('./cli/commands/list.ts')).list(sub);
    case 'add':
      return (await import('./cli/commands/add.ts')).add(sub);
    case 'remove':
    case 'rm':
    case 'delete':
      return (await import('./cli/commands/remove.ts')).remove(sub);
    case 'change':
    case 'edit':
      return (await import('./cli/commands/change.ts')).change(sub);
    case 'status':
      return (await import('./cli/commands/status.ts')).status(sub);
    case 'run':
      return (await import('./cli/commands/run.ts')).run(sub);
    case 'pause':
      return (await import('./cli/commands/pause.ts')).pause(sub);
    case 'resume':
      return (await import('./cli/commands/pause.ts')).resume(sub);
    case 'stop':
      return (await import('./cli/commands/pause.ts')).stop(sub);
    case 'log':
    case 'logs':
      return (await import('./cli/commands/log.ts')).log(sub);
    case 'plan':
      return (await import('./cli/commands/plan.ts')).plan(sub);
    case 'projects':
      return (await import('./cli/commands/list.ts')).list({ ...sub, flags: { ...sub.flags, projects: true } });
    case 'help':
    case '?':
      console.log(HELP);
      return 0;
    default:
      throw new CliError(`unknown command "${verb}"\n\n${HELP}`);
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code ?? 0),
  (err) => {
    if (err instanceof CliError) {
      console.error(red('error: ') + err.message);
      process.exit(err.exitCode);
    }
    console.error(err);
    process.exit(1);
  },
);
