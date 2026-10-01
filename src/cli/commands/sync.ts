import type { Parsed } from '../args.ts';
import { flagBool, flagStr } from '../args.ts';
import { openDb } from '../../db/db.ts';
import { listProjects } from '../../db/queries.ts';
import { resolveProject } from '../../core/resolve.ts';
import { CliError } from '../../core/errors.ts';
import { insideWorker, kernelPath, sandboxOn } from '../../core/kernel.ts';
import { dim, green } from '../../core/ansi.ts';
import { gitSync, reconcile } from '../../memory/sync.ts';
import { existsSync } from 'node:fs';
import { red } from '../../core/ansi.ts';
import { getRemote } from '../../sync/store.ts';
import { syncProject } from '../../sync/sync.ts';
import { helpIf } from './_shared.ts';

const HELP = `salu sync [project] [--all] [--no-git] [--no-push] [--no-inbox] [--dry-run]

Bring a project's memory (.salu/memory) and shared files (.salu/files) together:
  1. agents' sandbox copy <-> the project folder (newest change wins per file; if you and an agent both
     changed a file, your version stays and the agent's is kept as <name>.conflict-<id>)
  2. commit .salu/ in the project's git repo, pull what the remote has (fast-forward only), push the branch
  3. when the project has a remote (salu remote add): exchange tickets, replies and messages through
     its inbox, like salu remote sync
Nothing syncs unless you run this. --no-git stops after step 1; --no-push skips the push; --no-inbox skips step 3.
Only .salu/memory and .salu/files are touched; other files and branches are left alone.`;

export async function sync(p: Parsed): Promise<number> {
  if (helpIf(p, HELP)) return 0;
  if (insideWorker()) throw new CliError('salu sync is for you, not for agents');
  const db = openDb();
  const projects = flagBool(p, 'all') ? listProjects(db) : [resolveProject(db, p.positional[0] ?? flagStr(p, 'project'))];
  const dry = flagBool(p, 'dry-run');
  let failed = false;
  for (const project of projects) {
    const kernel = kernelPath(project.name);
    const label = project.name;
    let moved = 0;
    if (sandboxOn() && existsSync(kernel)) {
      const r = reconcile(project.name, project.path, kernel, { dryRun: dry });
      moved = r.toProject.length + r.toKernel.length + r.removed.length + r.conflicts.length;
      for (const f of r.toProject) console.log(`  ${dim('agents → project')}  ${f}`);
      for (const f of r.toKernel) console.log(`  ${dim('project → agents')}  ${f}`);
      for (const f of r.removed) console.log(`  ${dim('removed')}           ${f}`);
      for (const f of r.skipped) console.log(`  skipped          ${f} ${dim('(a link or special file is in the way)')}`);
      for (const f of r.conflicts) console.log(`  both changed      ${f} ${dim('(yours kept; the agent version saved alongside)')}`);
    }
    if (dry) {
      console.log(`${dim('dry run:')} ${label}: ${moved} file(s) would move`);
      continue;
    }
    if (!flagBool(p, 'no-inbox')) failed = inbox(db, project) || failed;
    if (flagBool(p, 'no-git')) {
      console.log(`${green('✓')} ${label}: ${moved ? `${moved} file(s) synced` : 'memory and files already in step'} ${dim('(git skipped)')}`);
      continue;
    }
    const g = gitSync(project.path, {
      push: !flagBool(p, 'no-push'),
      afterPull: () => {
        if (!(sandboxOn() && existsSync(kernel))) return false;
        const r = reconcile(project.name, project.path, kernel);
        moved += r.toProject.length + r.toKernel.length + r.removed.length;
        return r.toProject.length + r.removed.length > 0;
      },
    });
    const bits = [moved ? `${moved} file(s) synced` : 'in step', g.committed ? 'committed' : '', g.pulled ? 'pulled' : '', g.pushed ? 'pushed' : ''].filter(Boolean);
    console.log(`${green('✓')} ${label}: ${bits.join(', ')}`);
    for (const n of g.notes) console.log(`  ${dim('!')} ${n}`);
  }
  return failed ? 1 : 0;
}

/** The ticket inbox for projects that run on a box; true when it failed. */
function inbox(db: ReturnType<typeof openDb>, project: ReturnType<typeof resolveProject>): boolean {
  if (!getRemote(db, project.id)) return false;
  try {
    const r = syncProject(db, project);
    const bits = [`${r.ticketsSent + r.repliesSent + r.messagesSent} sent`, `${r.ticketsReceived + r.repliesReceived + r.messagesReceived} received`];
    console.log(`${green('✓')} ${project.name} inbox: ${bits.join(', ')}`);
    return false;
  } catch (e: any) {
    console.error(`${red('✗')} ${project.name} inbox: ${String(e?.message ?? e)}`);
    return true;
  }
}
