import type { Parsed } from '../args.ts';
import { flagBool, flagNum, flagStr } from '../args.ts';
import { openDb } from '../../db/db.ts';
import { getTicketById, queueAll, queueTicket, subtreeIds } from '../../db/queries.ts';
import { readStatus } from '../../orchestrator/status.ts';
import { resolveProject, resolveProjectRef, resolveTicket } from '../../core/resolve.ts';
import { checkClaude, loginProblem, preflightClaude } from '../../core/claude-bin.ts';
import { CliError } from '../../core/errors.ts';
import { helpIf, isTTY } from './_shared.ts';
import { applyAuthPolicy } from '../../core/env.ts';

const HELP = `salu run [project|"name"...] [--concurrency N] [--detach] [--plain] [--no-queue]

Queues every saved ticket (backlog), or only the tickets you name, or those in the project you name,
then starts the orchestrator. Adding a ticket never starts anything by itself. The orchestrator: claims tickets by priority then age, runs each as its own Claude
Code session (up to the concurrency cap, default 2), pauses on a rate limit and resumes
when the window resets. Foreground by default with a live view; --plain logs lines
instead; --detach runs it in the background (salu stop ends it). --no-queue starts the orchestrator
without queueing anything (what the always-on runner uses, so a restart never queues the backlog).`;

export async function run(p: Parsed): Promise<number> {
  if (helpIf(p, HELP)) return 0;
  const db = openDb();
  const missing = preflightClaude();
  if (missing) throw new CliError(missing);
  if (process.env.SALU_WORKER !== 'fake') {
    const c = checkClaude();
    const logged = c.ok && c.path ? await loginProblem(c.path) : null;
    if (logged) throw new CliError(logged);
  }
  const auth = applyAuthPolicy();
  if (auth.warning) console.error(`warning: ${auth.warning}`);
  // Arguments name a project (its saved tickets are queued) or tickets (just those are queued).
  // No arguments: every saved ticket is queued. Adding alone never starts anything.
  const args = [...p.positional];
  const projectFlag = flagStr(p, 'project');
  let project: ReturnType<typeof resolveProject> | null = projectFlag ? resolveProject(db, projectFlag) : null;
  const tickets: number[] = [];
  for (const a of args) {
    let asProject = null;
    try {
      asProject = resolveProjectRef(db, a);
    } catch {
      /* not a project: a ticket */
    }
    if (asProject && !project && !tickets.length) project = asProject;
    else tickets.push(resolveTicket(db, a, { project: project?.name }).id);
  }
  const scope = project ? subtreeIds(db, project.id) : undefined;
  let queued = 0;
  if (flagBool(p, 'no-queue')) {
    /* start only what is already queued */
  } else if (tickets.length) {
    for (const id of tickets) {
      const t = getTicketById(db, id);
      if (t && t.status !== 'running' && t.status !== 'paused') {
        queueTicket(db, id);
        queued++;
      }
    }
  } else queued = queueAll(db, { projectIds: scope });
  if (queued) console.error(`queued ${queued} ticket${queued === 1 ? '' : 's'}`);
  const concurrency = flagNum(p, 'concurrency');
  const live = readStatus(db);
  if (live.alive && live.pid && live.pid !== process.pid) {
    console.log(`an orchestrator is already running (pid ${live.pid}); ${queued ? `${queued} ticket${queued === 1 ? '' : 's'} queued, it will pick ${queued === 1 ? 'it' : 'them'} up` : 'nothing new to queue'}`);
    return 0;
  }
  const { startOrchestratorCommand } = await import('../../orchestrator/index.ts');
  return startOrchestratorCommand({
    projectIds: scope,
    concurrency,
    detach: flagBool(p, 'detach'),
    plain: flagBool(p, 'plain') || !isTTY(),
  });
}
