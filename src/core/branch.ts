import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ticketSlug } from '../orchestrator/prompt.ts';

/** The branch workers are told to commit on. */
export function ticketBranchName(ticketName: string): string {
  return `salu/${ticketSlug(ticketName)}`;
}

/** The ticket's branch when `dir` is a git repository that has it, else null. */
export function ticketBranch(dir: string, ticketName: string): string | null {
  if (!existsSync(join(dir, '.git'))) return null;
  const name = ticketBranchName(ticketName);
  const r = Bun.spawnSync(['git', 'rev-parse', '--verify', '--quiet', `refs/heads/${name}`], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  return r.exitCode === 0 ? name : null;
}
