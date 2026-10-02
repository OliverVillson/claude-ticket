import { readFileSync } from 'node:fs';
import type { Parsed } from '../args.ts';
import { flagBool, flagStr } from '../args.ts';
import { CliError } from '../../core/errors.ts';
import { dim, green, red } from '../../core/ansi.ts';
import { realExec } from '../../boxmac/exec.ts';
import { controlApi } from '../../boxmac/control.ts';
import { addBox, loginViaControl, makeTokenReader, statusLines, type Deps } from '../../boxmac/pair.ts';
import { listBoxes, pickBox, removeBoxFile } from '../../boxmac/state.ts';
import { spawnSync } from 'node:child_process';
import { boxDir, boxInit, readBoxName } from '../../box/init.ts';
import { saveConnection } from '../../control/keys.ts';
import { boxLoginFile, saveBoxLogin } from '../../box/login.ts';
import { selfCommand } from '../../orchestrator/index.ts';
import { VERSION } from '../dispatch.ts';
import { helpIf } from './_shared.ts';

const HELP = `salu box add <user@host> [--name box] [--repo owner/name] [--token-file f] [--fresh] [--host-key SHA256:...]
salu box status [--on box] [--json]
salu box update [version] [--on box]
salu box login [--on box] [--token-file f]
salu box list
salu box remove <box> [--yes]
salu box init [--json] [--name box]          (on the box; pairing runs these)
salu box connect --url <ssh-url> --mac-key -
salu box login --stdin                       (on the box: the token comes in on stdin)

Set up an always-on computer (a salu box) from this one.
add       pairs with the box over ssh once: installs salu there, makes a private repo
          (salu-control) for commands, gives the box a login for Claude, and checks it answers.
          Run it again if it stops half way: it carries on where it was.
status    asks the box how it is doing (version, disk, tickets, the safety check).
update    updates salu on the box to the latest release (or a given version).
login     gives the box a fresh Claude login (when the old one ran out).
init      the box's own side of pairing: makes its keys, once. --json prints them on one line.
connect    the box's side of pairing: saves the control repo and the Mac's key (stdin), starts the service.
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

async function askYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = (await import('node:readline')).createInterface({ input: process.stdin, output: process.stdout });
  const a: string = await new Promise((res) => rl.question(question, res));
  rl.close();
  return /^y(es)?$/i.test(a.trim());
}

export function realDeps(): Deps {
  return { exec: realExec, control: controlApi, say: (l) => console.log(l), askSecret: readSecret, confirm: askYesNo };
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
      await addBox(deps, { host: rest[0], name: flagStr(p, 'name'), repo: flagStr(p, 'repo'), tokenFile, fresh: flagBool(p, 'fresh'), hostKey: flagStr(p, 'host-key') }, read);
      return 0;
    }
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
      if (flagBool(p, 'stdin')) {
        // The box's side: the Mac sends the token over ssh stdin, never on the command line.
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
