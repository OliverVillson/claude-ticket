import type { Parsed } from '../args.ts';
import { flagBool, flagNum, flagStr } from '../args.ts';
import { openDb } from '../../db/db.ts';
import { resolveProject } from '../../core/resolve.ts';
import { helpIf, isTTY } from './_shared.ts';
import { applyAuthPolicy } from '../../core/env.ts';

const HELP = `ticket run [project] [--concurrency N] [--detach] [--plain]

Starts the orchestrator: claims tickets by priority then age, runs each as its own Claude
Code session (up to the concurrency cap, default 2), pauses on a rate limit and resumes
when the window resets. Foreground by default with a live view; --plain logs lines
instead; --detach runs it in the background (ticket stop ends it).`;

export async function run(p: Parsed): Promise<number> {
  if (helpIf(p, HELP)) return 0;
  const db = openDb();
  const auth = applyAuthPolicy();
  if (auth.warning) console.error(`warning: ${auth.warning}`);
  const projectName = p.positional[0] ?? flagStr(p, 'project');
  const project = projectName ? resolveProject(db, projectName) : null;
  const concurrency = flagNum(p, 'concurrency');
  const { startOrchestratorCommand } = await import('../../orchestrator/index.ts');
  return startOrchestratorCommand({
    projectIds: project ? [project.id] : undefined,
    concurrency,
    detach: flagBool(p, 'detach'),
    plain: flagBool(p, 'plain') || !isTTY(),
  });
}
