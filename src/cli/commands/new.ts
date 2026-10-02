import type { Parsed } from '../args.ts';
import { flagNum, flagStr } from '../args.ts';
import { basename } from 'node:path';
import { CliError } from '../../core/errors.ts';
import { openDb } from '../../db/db.ts';
import { getProjectByName } from '../../db/queries.ts';
import { getRemote } from '../../sync/store.ts';
import { newProject, slugName, type Registrar } from '../../boxmac/project.ts';
import { pickBox } from '../../boxmac/state.ts';
import { dispatch } from '../dispatch.ts';
import { realDeps } from './box.ts';
import { helpIf } from './_shared.ts';
import type { Deps } from '../../boxmac/pair.ts';

const HELP = `salu new [name] [--on box] [--repo owner/name] [--path folder] [--concurrency N]

Make a project that runs on your box, in one step. It makes (or uses) a private GitHub repo,
gives the box its own key for that repo, has the box set it up, then copies the repo here and
registers the project, so \`salu add "idea"\` goes straight to the box.
A public repo is refused. Run it again if it stops half way: it carries on.
No name: the name of the current folder. Pair a box first with: salu box add user@host`;

function registrar(): Registrar {
  const db = openDb();
  return {
    hasProject: (n) => !!getProjectByName(db, n),
    hasRemote: (n) => {
      const pr = getProjectByName(db, n);
      return !!pr && !!getRemote(db, pr.id);
    },
    addProject: async (n, path) => {
      if ((await dispatch(['add', 'project', n, path])) !== 0) throw new CliError(`could not register project "${n}" here`);
    },
    addRemote: async (n, url) => {
      if ((await dispatch(['remote', 'add', n, url])) !== 0) throw new CliError(`could not link "${n}" to the box`);
    },
  };
}

export async function newCmd(p: Parsed, deps: Deps = realDeps(), reg: () => Registrar = registrar): Promise<number> {
  if (helpIf(p, HELP)) return 0;
  const raw = p.positional[0] ?? basename(process.cwd());
  const name = slugName(raw);
  if (!name) throw new CliError('give the project a name: salu new <name>');
  if (name !== raw) deps.say(`(using the name "${name}")`);
  const box = pickBox(flagStr(p, 'on'));
  await newProject(deps, box, { name, repo: flagStr(p, 'repo'), path: flagStr(p, 'path'), concurrency: flagNum(p, 'concurrency') }, reg());
  return 0;
}
