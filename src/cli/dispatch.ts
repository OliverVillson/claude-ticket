// Command dispatch shared by the CLI entry point and the TUI command line, so both run exactly
// the same handlers. Handlers are imported lazily to keep startup light.
import { parseArgs } from './args.ts';
import { CliError } from '../core/errors.ts';

export const VERSION = '0.2.2';

export const HELP = `salu — a fast ticket queue for Claude Code agents

Usage   (salu ?  |  salu help  |  salu --help  shows this list; quote the ? in zsh: salu '?')
  salu add project "name" [path] [--in parent] [--model M] [--effort E] [--tools T] [--concurrency N] [--default]
  salu add "name" ["query"] ["tags"]           no project? one is made ("<name>-proj", in ./<name>-proj)
                                               tags: key=value pairs and bare labels
  salu remove "name" [--yes]                 (also: salu remove project "name")
  salu change "name" [--name N] [--query Q] [--tags T] [--priority P] [--status S]
  salu change project "name" [--in parent|none] [--path P] [--model M] [--effort E] [--tools T] [--concurrency N] [--default]
  salu list [project] [--plain] [--status S] [--projects] [--json]
  salu queue "name"... | --all [project]     queue saved tickets to run (add only saves; nothing runs by itself)
  salu unqueue "name"                        take a queued ticket back to the backlog
  salu run [project|"name"...] [--concurrency N] [--detach] [--plain]
                                             queue everything saved (or just the named tickets) and start
  salu pause | salu resume | salu stop
  salu status [--json]
  salu usage [--json] [--refresh]            how much of your Claude plan's 5-hour and weekly usage is left
  salu log "name" [--follow] [--raw]
  salu plan "name"                           split a ticket into sub-tickets with Claude
  salu doctor                                check that Claude Code is found and you are logged in
  salu update [version] [--check]            update salu to the latest release (or a given version)

Tags
  project=<name>  model=opus|sonnet|haiku|<id>  effort=low|medium|high|xhigh|max
  defaults: model claude-opus-5-5, effort medium (set per ticket, or per project with --model/--effort)
  priority=1..5 (1 highest, default 3)  max-turns=<n>  permission=plan|default|acceptEdits|bypass
  anything else (bug, docs, …) is a label

Run \`salu <command> --help\` for details. Data lives in ~/.salu (override with SALU_HOME).`;

export async function dispatch(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  const [verb, ...rest] = parsed.positional;
  if (parsed.flags.version) {
    console.log(`salu ${VERSION}`);
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
      return (await import('./commands/list.ts')).list(sub);
    case 'add':
      return (await import('./commands/add.ts')).add(sub);
    case 'remove':
    case 'rm':
    case 'delete':
      return (await import('./commands/remove.ts')).remove(sub);
    case 'change':
    case 'edit':
      return (await import('./commands/change.ts')).change(sub);
    case 'usage':
      return (await import('./commands/usage.ts')).usage(sub);
    case 'status':
      return (await import('./commands/status.ts')).status(sub);
    case 'run':
      return (await import('./commands/run.ts')).run(sub);
    case 'queue':
      return (await import('./commands/queue.ts')).queue(sub);
    case 'unqueue':
      return (await import('./commands/queue.ts')).unqueue(sub);
    case 'pause':
      return (await import('./commands/pause.ts')).pause(sub);
    case 'resume':
      return (await import('./commands/pause.ts')).resume(sub);
    case 'stop':
      return (await import('./commands/pause.ts')).stop(sub);
    case 'log':
    case 'logs':
      return (await import('./commands/log.ts')).log(sub);
    case 'plan':
      return (await import('./commands/plan.ts')).plan(sub);
    case 'doctor':
      return (await import('./commands/doctor.ts')).doctor(sub);
    case 'update':
    case 'upgrade':
      return (await import('./commands/update.ts')).update(sub);
    case 'projects':
      return (await import('./commands/list.ts')).list({ ...sub, flags: { ...sub.flags, projects: true } });
    case 'help':
    case '?':
      console.log(HELP);
      return 0;
    default:
      throw new CliError(`unknown command "${verb}"\n\n${HELP}`);
  }
}

