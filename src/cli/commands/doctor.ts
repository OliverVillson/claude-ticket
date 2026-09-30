import type { Parsed } from '../args.ts';
import { checkClaude, environmentProblem, loginProblem, runningCompiled } from '../../core/claude-bin.ts';
import { applyAuthPolicy } from '../../core/env.ts';
import { probeWindow } from '../../usage/index.ts';
import { ensureHome } from '../../core/paths.ts';
import { dim, green, red } from '../../core/ansi.ts';
import { openDb } from '../../db/db.ts';
import { listRemotes } from '../../sync/store.ts';
import { unsignedWarning } from '../../sync/format.ts';
import { sandboxSupport } from '../../core/kernel.ts';
import { VERSION } from '../dispatch.ts';
import { helpIf } from './_shared.ts';

const HELP = `salu doctor

Checks that salu can do its job on this machine: Claude Code is installed and reachable, you are
logged in (it sends one tiny test request to check the login really works), and the data folder is writable. Exits with 1 when something needs fixing.`;

async function run(cmd: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const p = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe', env: process.env });
    const timer = setTimeout(() => p.kill(), 8000);
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    clearTimeout(timer);
    return { ok: (await p.exited) === 0, out: (out || err).trim().split('\n')[0] ?? '' };
  } catch (e: any) {
    return { ok: false, out: String(e?.message ?? e) };
  }
}

export async function doctor(p: Parsed): Promise<number> {
  if (helpIf(p, HELP)) return 0;
  let bad = 0;
  const ok = (m: string) => console.log(`${green('✓')} ${m}`);
  const no = (m: string, fix?: string) => {
    bad++;
    console.log(`${red('✗')} ${m}`);
    if (fix) console.log(`  ${dim(fix)}`);
  };
  ok(`salu ${VERSION} (${runningCompiled() ? 'compiled binary' : 'running from source'})`);

  const sb = sandboxSupport();
  if (sb.ok) ok('the kernel sandbox can run here (salu add project --sandbox)');
  else console.log(`${dim('·')} the kernel sandbox cannot run here: ${sb.problem}`);

  const c = checkClaude();
  if (!c.ok) {
    no('Claude Code was not found', c.problem);
  } else {
    const v = await run([c.path!, '--version']);
    if (!v.ok) no(`${c.path} does not run: ${v.out}`, 'Reinstall Claude Code: curl -fsSL https://claude.ai/install.sh | bash');
    else {
      ok(`Claude Code ${v.out} at ${c.path} ${dim(`(${c.source})`)}`);
      const a = await run([c.path!, 'auth', 'status']);
      const out = await loginProblem(c.path!);
      if (out) no('Claude Code is logged out', out);
      else if (a.ok) ok(`logged in ${dim(a.out)}`.trimEnd());
      else console.log(`${dim('·')} could not confirm the login (${a.out || 'no answer'}).`);
      // The status command can say "logged in" for a login that has since expired: ask Claude for real.
      if (!out && process.env.SALU_WORKER !== 'fake') {
        const pr = await probeWindow({ model: 'haiku', cwd: process.env.TMPDIR || '/tmp' });
        const env = pr.status === 'unknown' ? environmentProblem(pr.detail) : null;
        if (env) no('Claude Code rejected a test request', env);
        else if (pr.status === 'unknown') console.log(`${dim('·')} could not run a test request (${pr.detail ?? 'no answer'}).`);
        else if (pr.status === 'closed') console.log(`${dim('·')} Claude Code answers, but a usage limit is in effect (${pr.detail ?? 'limit'}).`);
        else ok('Claude Code answers a test request');
      }
    }
  }

  const auth = applyAuthPolicy({ ...process.env });
  if (auth.warning) console.log(`${dim('·')} ${auth.warning}`);

  try {
    const w = listRemotes(openDb()).length ? unsignedWarning() : null;
    if (w) console.log(`${red('!')} ${w}`); // a warning, not a failure: requiring a key is your call
  } catch {
    /* the database may not exist yet */
  }

  try {
    ok(`data folder ${ensureHome()}`);
  } catch (e: any) {
    no(`cannot write the data folder: ${String(e?.message ?? e)}`);
  }
  console.log(bad ? `\n${bad} problem${bad === 1 ? '' : 's'} to fix.` : '\nAll good.');
  return bad ? 1 : 0;
}
