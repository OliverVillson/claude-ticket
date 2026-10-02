import type { Parsed } from '../args.ts';
import { flagBool, flagStr } from '../args.ts';
import { CliError } from '../../core/errors.ts';
import { dim, green } from '../../core/ansi.ts';
import { boxDir, boxInit } from '../../box/init.ts';
import { VERSION } from '../dispatch.ts';
import { helpIf } from './_shared.ts';

const HELP = `salu box init [--json] [--name NAME]

The box side of pairing with a Mac (docs/control-channel.md).

  salu box init     make the box's keys (deploy, seal, box) in ${'/var/lib/salu/box'}, once; run again it changes nothing
                    --json prints one line: {"box","deployPub","sealPub","boxKey","version"}
                    --name sets the box name (default: the host name)`;

export async function box(p: Parsed): Promise<number> {
  if (helpIf(p, HELP)) return 0;
  const [sub = ''] = p.positional;
  switch (sub) {
    case 'init': {
      const r = boxInit({ name: flagStr(p, 'name'), version: VERSION });
      if (flagBool(p, 'json')) {
        console.log(JSON.stringify(r));
        return 0;
      }
      console.log(`${green('✓')} box "${r.box}" has its keys in ${boxDir()} ${dim(`(salu ${r.version})`)}`);
      console.log(dim('pair a Mac with: salu box add <user@host>   (on the Mac)'));
      return 0;
    }
    default:
      throw new CliError(`unknown box command "${sub}"\n\n${HELP}`);
  }
}
