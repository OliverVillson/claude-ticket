import type { Parsed } from '../args.ts';
import { flagBool, flagStr } from '../args.ts';
import { CliError } from '../../core/errors.ts';
import { dim, green } from '../../core/ansi.ts';
import { spawnSync } from 'node:child_process';
import { boxDir, boxInit, readBoxName } from '../../box/init.ts';
import { saveConnection } from '../../control/keys.ts';
import { VERSION } from '../dispatch.ts';
import { helpIf } from './_shared.ts';

const HELP = `salu box init [--json] [--name NAME]
salu box connect --url <ssh-url> --mac-key -

The box side of pairing with a Mac (docs/control-channel.md).

  salu box init     make the box's keys (deploy, seal, box) in ${'/var/lib/salu/box'}, once; run again it changes nothing
                    --json prints one line: {"box","deployPub","sealPub","boxKey","version"}
                    --no-secret leaves the box's secret key out of the JSON (safe to print)
                    --name sets the box name (default: the host name)
  salu box connect  save the control repo url and the Mac's signing key (base64, from stdin), then start salu-control.service`;

export async function box(p: Parsed): Promise<number> {
  if (helpIf(p, HELP)) return 0;
  const [sub = ''] = p.positional;
  switch (sub) {
    case 'init': {
      const r = boxInit({ name: flagStr(p, 'name'), version: VERSION });
      if (flagBool(p, 'json')) {
        // --no-secret leaves boxKey out: for anything printed to a terminal or a log (the installer). Only `salu box add` asks for the key, over its own ssh channel.
        const { boxKey, ...pub } = r;
        console.log(JSON.stringify(p.flags.secret === false ? pub : r));
        return 0;
      }
      console.log(`${green('✓')} box "${r.box}" has its keys in ${boxDir()} ${dim(`(salu ${r.version})`)}`);
      console.log(dim('pair a Mac with: salu box add <user@host>   (on the Mac)'));
      return 0;
    }
    case 'connect': {
      const url = flagStr(p, 'url');
      if (!url || !/^git@github\.com:[\w.-]+\/[\w.-]+\.git$/.test(url)) throw new CliError('--url must look like git@github.com:<owner>/<repo>.git');
      if (flagStr(p, 'mac-key') !== '-') throw new CliError('the Mac key is read from stdin: pass --mac-key -');
      const key = Buffer.from((await new Response(Bun.stdin.stream()).text()).trim(), 'base64');
      if (key.length !== 32) throw new CliError('the Mac key must be 32 bytes, base64 encoded, on stdin');
      const name = readBoxName();
      if (!name) throw new CliError('this box has no keys yet: run salu box init first');
      saveConnection(url, name, key);
      const r = spawnSync('systemctl', ['enable', '--now', 'salu-control.service'], { encoding: 'utf8' });
      if (r.status !== 0) throw new CliError(`saved, but the control service did not start: ${(r.stderr || r.error?.message || '').trim()} (run as root; the installer sets the service up)`);
      if (flagBool(p, 'json')) console.log(JSON.stringify({ ok: true, box: name }));
      else console.log(`${green('✓')} connected "${name}" to ${url}; the control service is running`);
      return 0;
    }
    default:
      throw new CliError(`unknown box command "${sub}"\n\n${HELP}`);
  }
}
