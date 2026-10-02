import type { Parsed } from '../args.ts';
import { flagBool, flagStr } from '../args.ts';
import { CliError } from '../../core/errors.ts';
import { dim, green } from '../../core/ansi.ts';
import { spawnSync } from 'node:child_process';
import { boxDir, boxInit } from '../../box/init.ts';
import { boxLoginFile, saveBoxLogin } from '../../box/login.ts';
import { selfCommand } from '../../orchestrator/index.ts';
import { VERSION } from '../dispatch.ts';
import { helpIf } from './_shared.ts';

const HELP = `salu box init [--json] [--name NAME]
salu box login --stdin

The box side of pairing with a Mac (docs/control-channel.md).

  salu box init     make the box's keys (deploy, seal, box) in ${'/var/lib/salu/box'}, once; run again it changes nothing
                    --json prints one line: {"box","deployPub","sealPub","boxKey","version"}
                    --name sets the box name (default: the host name)
  salu box login    save the one Claude login of this box (the token \`claude setup-token\` prints), read from stdin
                    with no terminal, so a Mac can send it over ssh. Every runner project and the kernel use it.`;

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
    case 'login': {
      if (!flagBool(p, 'stdin')) throw new CliError('usage: salu box login --stdin   (the token goes in on stdin, never on the command line)');
      const token = (await new Response(Bun.stdin.stream()).text()).trim();
      if (!token) throw new CliError('no token on stdin: run `claude setup-token` and pipe it in');
      try {
        saveBoxLogin(token);
      } catch (e: any) {
        // Not allowed to write the box's folder (an ordinary ssh user): run again through passwordless sudo, with the token on stdin.
        if (!/EACCES|EPERM|permission/i.test(String(e?.message)) || process.getuid?.() === 0) throw new CliError(e.message);
        const r = spawnSync('sudo', ['-n', ...selfCommand(['box', 'login', '--stdin'])], { input: token, encoding: 'utf8' });
        if (r.status !== 0) throw new CliError(`this user cannot write ${boxLoginFile()} and sudo is not available without a password: run it as root, or as the user that owns /var/lib/salu`);
      }
      console.log(`${green('✓')} the box login is saved ${dim('(every runner project and the kernel use it)')}`);
      return 0;
    }
    default:
      throw new CliError(`unknown box command "${sub}"\n\n${HELP}`);
  }
}
