import { readFileSync } from 'node:fs';
import type { Parsed } from '../args.ts';
import { flagBool, flagStr } from '../args.ts';
import { CliError } from '../../core/errors.ts';
import { dim, green, red } from '../../core/ansi.ts';
import { realExec } from '../../boxmac/exec.ts';
import { controlApi } from '../../boxmac/control.ts';
import { addBox, loginViaControl, makeTokenReader, statusLines, type Deps } from '../../boxmac/pair.ts';
import { listBoxes, pickBox, removeBoxFile } from '../../boxmac/state.ts';
import { helpIf } from './_shared.ts';

const HELP = `salu box add <user@host> [--name box] [--repo owner/name] [--token-file f] [--fresh]
salu box status [--on box] [--json]
salu box update [version] [--on box]
salu box login [--on box] [--token-file f]
salu box list
salu box remove <box> [--yes]

Set up an always-on computer (a salu box) from this one.
add       pairs with the box over ssh once: installs salu there, makes a private repo
          (salu-control) for commands, gives the box a login for Claude, and checks it answers.
          Run it again if it stops half way: it carries on where it was.
status    asks the box how it is doing (version, disk, tickets, the safety check).
update    updates salu on the box to the latest release (or a given version).
login     gives the box a fresh Claude login (when the old one ran out).
After pairing, \`salu new <name>\` makes a project that runs on the box.

--on picks the box when you have more than one. Pairing keys are kept in ~/.salu/boxes (readable by you only).`;

/** Read a line from the terminal without showing it. */
async function readSecret(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const text = await new Response(Bun.stdin.stream()).text();
    return text.split('\n')[0]!.trim();
  }
  process.stdout.write(question);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  return await new Promise<string>((res, rej) => {
    let buf = '';
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off('data', onData);
          process.stdout.write('\n');
          return res(buf);
        }
        if (c === '\u0003') {
          process.stdin.setRawMode(false);
          process.stdout.write('\n');
          return rej(new CliError('stopped'));
        }
        if (c === '\u007f') buf = buf.slice(0, -1);
        else buf += c;
      }
    };
    process.stdin.on('data', onData);
  });
}

export function realDeps(): Deps {
  return { exec: realExec, control: controlApi, say: (l) => console.log(l), askSecret: readSecret };
}

const readFile = (p: string) => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    throw new CliError(`could not read ${p}`);
  }
};

export async function box(p: Parsed, deps: Deps = realDeps()): Promise<number> {
  if (helpIf(p, HELP)) return 0;
  const [sub, ...rest] = p.positional;
  const on = flagStr(p, 'on');
  switch (sub) {
    case 'add': {
      if (!rest[0]) throw new CliError('usage: salu box add user@host   (the box you installed Ubuntu on)');
      const tokenFile = flagStr(p, 'token-file');
      const read = makeTokenReader(deps, tokenFile, readFile);
      await addBox(deps, { host: rest[0], name: flagStr(p, 'name'), repo: flagStr(p, 'repo'), tokenFile, fresh: flagBool(p, 'fresh') }, read);
      return 0;
    }
    case 'status': {
      const b = pickBox(on);
      const r = await deps.control().call(b, 'status', {}, { timeoutMs: 120_000 });
      if (flagBool(p, 'json')) console.log(JSON.stringify({ box: b.box, ...r }, null, 2));
      else {
        console.log(`${b.box} ${dim(b.host)}`);
        for (const l of statusLines(r)) console.log(l);
      }
      return r.ok ? 0 : 1;
    }
    case 'update': {
      const b = pickBox(on);
      console.log('Asking the box to update (this can take several minutes)...');
      const r = await deps.control().call(b, 'update', rest[0] ? { version: rest[0] } : {}, { timeoutMs: 15 * 60_000 });
      console.log(r.ok ? `${green('✓')} ${r.message}` : `${red('✗')} ${r.message}`);
      return r.ok ? 0 : 1;
    }
    case 'login': {
      const b = pickBox(on);
      const token = await makeTokenReader(deps, flagStr(p, 'token-file'), readFile)();
      const r = await loginViaControl(deps, b, token);
      console.log(r.ok ? `${green('✓')} ${r.message}` : `${red('✗')} ${r.message}`);
      return r.ok ? 0 : 1;
    }
    case 'list':
    case 'ls':
    case undefined: {
      const rows = listBoxes();
      if (!rows.length) {
        console.log('no box yet. Pair one with: salu box add user@host');
        return 0;
      }
      for (const b of rows) console.log(`${b.box}  ${dim(`${b.host}  ${b.paired ? 'paired' : 'not finished: run salu box add again'}`)}`);
      return 0;
    }
    case 'remove':
    case 'rm': {
      if (!rest[0]) throw new CliError('usage: salu box remove <box>');
      const b = pickBox(rest[0]);
      if (!flagBool(p, 'yes')) throw new CliError(`this only forgets box "${b.box}" on this computer (nothing on the box changes). Add --yes to do it.`);
      removeBoxFile(b.box);
      console.log(`${green('✓')} forgot ${b.box}`);
      return 0;
    }
    default:
      throw new CliError(`unknown: salu box ${sub}\n\n${HELP}`);
  }
}
