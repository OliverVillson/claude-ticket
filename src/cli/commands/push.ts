import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Parsed } from '../args.ts';
import { flagBool, flagStr } from '../args.ts';
import { openDb } from '../../db/db.ts';
import { resolveProject } from '../../core/resolve.ts';
import { CliError } from '../../core/errors.ts';
import { dim, green } from '../../core/ansi.ts';
import { copyTree, isEmptyDir, isGitRepo, kernelPath, listBranches, originUrl, requireHuman } from '../../core/kernel.ts';
import { helpIf } from './_shared.ts';

const PUSH_HELP = `salu push [project] [--branch B] [--to git-url] [--dry-run]

Sends what agents made in a project's kernel (~/.salu/kernel/<project>) to the git remote of the
real project (its "origin"), or to --to. By default every salu/* branch is pushed; --branch names one.
It runs as you, with your git login, and never from an agent: workers cannot run it and never see
your credentials.`;

const EXPORT_HELP = `salu export <folder> [project] [--git] [--force]

Copies the files in a project's kernel to a folder on this computer (without the .git folder, unless
--git). The folder must be new or empty, unless --force. Never run by agents.`;

function projectWithKernel(p: Parsed, name: string | undefined) {
  const project = resolveProject(openDb(), name ?? flagStr(p, 'project'));
  const dir = kernelPath(project.name);
  if (!existsSync(dir)) throw new CliError(`project "${project.name}" has no kernel yet. Turn it on with: salu change project "${project.name}" --sandbox, then run a ticket.`);
  return { project, dir };
}

export async function push(p: Parsed): Promise<number> {
  if (helpIf(p, PUSH_HELP)) return 0;
  requireHuman('push');
  const { project, dir } = projectWithKernel(p, p.positional[0]);
  if (!isGitRepo(dir)) throw new CliError(`the kernel of "${project.name}" is not a git repository, so there is nothing to push. Use salu export <folder>.`);
  const target = flagStr(p, 'to') ?? originUrl(project.path);
  if (!target) throw new CliError(`"${project.name}" has no git remote to push to. Pass one: salu push --to https://github.com/you/repo`);
  const only = flagStr(p, 'branch');
  const branches = only ? [only] : listBranches(dir).filter((b) => b.startsWith('salu/'));
  if (!branches.length) throw new CliError('no salu/* branches in the kernel yet (agents commit on a salu/<ticket> branch). Name one with --branch, or check `salu log`.');
  const args = ['-c', 'core.hooksPath=/dev/null', 'push', ...(flagBool(p, 'dry-run') ? ['--dry-run'] : []), target, ...branches.map((b) => `refs/heads/${b}:refs/heads/${b}`)];
  const r = Bun.spawnSync(['git', ...args], { cwd: dir, stdout: 'inherit', stderr: 'inherit', stdin: 'inherit', env: process.env as Record<string, string> });
  if (r.exitCode !== 0) throw new CliError(`git push failed (exit ${r.exitCode}). Check that you are logged in to ${target}.`);
  console.log(`${green('✓')} ${flagBool(p, 'dry-run') ? 'would push' : 'pushed'} ${branches.join(', ')} ${dim(`→ ${target}`)}`);
  return 0;
}

export async function exportKernel(p: Parsed): Promise<number> {
  if (helpIf(p, EXPORT_HELP)) return 0;
  requireHuman('export');
  const folder = p.positional[0];
  if (!folder) throw new CliError('usage: salu export <folder> [project]');
  const { project, dir } = projectWithKernel(p, p.positional[1]);
  const dest = resolve(folder);
  if (dest === resolve(project.path) && !flagBool(p, 'force')) throw new CliError('that is the project folder itself; pick another folder or pass --force to overwrite files in it');
  if (!isEmptyDir(dest) && !flagBool(p, 'force')) throw new CliError(`${dest} is not empty. Pick a new folder, or pass --force to copy over it.`);
  mkdirSync(dest, { recursive: true });
  copyTree(dir, dest, { skipGit: !flagBool(p, 'git') });
  console.log(`${green('✓')} copied the kernel of "${project.name}" ${dim(`→ ${dest}`)}`);
  return 0;
}
