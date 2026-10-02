import { bad, firstProblem, NAME_RE, REPO_RE, withSecretFiles } from './common.ts';
import type { BoxDeps, Handler } from './types.ts';

interface Row {
  project: string;
  service: string;
  sync: string | null;
  todo: number;
  running: number;
  blocked: number;
  done: number;
}

export async function listProjects(deps: BoxDeps): Promise<Row[]> {
  const r = await deps.run([deps.salu, 'runner', 'list', '--json']);
  if (!r.ok) return [];
  try {
    const start = r.out.indexOf('[');
    return start < 0 ? [] : (JSON.parse(r.out.slice(start)) as Row[]);
  } catch {
    return [];
  }
}

/** Restart every runner project that has no ticket running; busy ones keep running and are named. */
export async function restartIdleProjects(deps: BoxDeps): Promise<{ restarted: string[]; busy: string[] }> {
  const restarted: string[] = [];
  const busy: string[] = [];
  for (const p of await listProjects(deps)) {
    if (p.running > 0) busy.push(p.project);
    else if ((await deps.run([deps.salu, 'runner', 'restart', p.project])).ok) restarted.push(p.project);
  }
  return { restarted, busy };
}

/**
 * `project.create`: clone the project's private repo with its own deploy key, register it as a runner project that
 * uses the one box login, set the signing key, trust github.com's host key and start it. Everything is one
 * `salu runner add`, so a half-made project cleans up after itself the way the command does.
 */
export const projectCreate = (deps: BoxDeps): Handler => async ({ args, secret }) => {
  const name = String(args?.name ?? '');
  const repo = String(args?.repo ?? '');
  if (!NAME_RE.test(name)) return bad('the project name must be lowercase letters, digits and - (at most 40): rename it and send again');
  if (!REPO_RE.test(repo)) return bad('the repo must be an ssh address like git@github.com:you/project.git');
  const conc = args?.concurrency;
  if (conc !== undefined && !(Number.isInteger(conc) && conc >= 1 && conc <= 32)) return bad('concurrency is a whole number from 1 to 32');
  let deployKey: Buffer, signingKey: Buffer;
  try {
    deployKey = secret('deployKey');
    signingKey = secret('signingKey');
  } catch {
    return bad('the command did not carry the project keys: send it again from your Mac (salu new)');
  }
  const existing = (await listProjects(deps)).find((p) => p.project === name);
  if (existing) return { ok: true, message: `"${name}" already runs on this box`, data: { project: name, existed: true } };
  const r = await withSecretFiles(deps, { deploy: deployKey, signing: signingKey }, (f) =>
    deps.run([deps.salu, 'runner', 'add', name, '--clone', repo, '--deploy-key-file', f.deploy!, '--signing-key-file', f.signing!, ...(conc ? ['--concurrency', String(conc)] : [])], { env: { SALU_RUNNER_USER: deps.user } }),
  );
  if (!r.ok) {
    const why = firstProblem(r.out);
    const hint = /permission denied|publickey|could not read from remote/i.test(r.out) ? ' (is the deploy key added to the repo with write access?)' : /no box login|login/i.test(why) ? ' (the box has no login yet: send the login first)' : '';
    return bad(`could not set up "${name}": ${why}${hint}`);
  }
  return { ok: true, message: `"${name}" is running on the box`, data: { project: name } };
};

/** `project.remove`: stop and disable the runner; `purge` also deletes its tickets, logs and kernel. */
export const projectRemove = (deps: BoxDeps): Handler => async ({ args }) => {
  const name = String(args?.name ?? '');
  if (!NAME_RE.test(name)) return bad('the project name must be lowercase letters, digits and -');
  if (!(await listProjects(deps)).some((p) => p.project === name)) return { ok: true, message: `"${name}" is not on this box (nothing to remove)`, data: { project: name, existed: false } };
  const purge = args?.purge === true;
  const r = await deps.run([deps.salu, 'runner', 'remove', name, '--yes', ...(purge ? ['--purge'] : [])]);
  if (!r.ok) return bad(`could not remove "${name}": ${firstProblem(r.out)}`);
  return { ok: true, message: purge ? `"${name}" and its data are removed` : `"${name}" is stopped (its data stays; remove with purge to delete it)`, data: { project: name, purged: purge } };
};
