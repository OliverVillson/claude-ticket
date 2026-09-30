import type { Parsed } from '../args.ts';
import { checkClaude, runningCompiled } from '../../core/claude-bin.ts';
import { applyAuthPolicy } from '../../core/env.ts';
import { ensureHome } from '../../core/paths.ts';
import { dim, green, red } from '../../core/ansi.ts';
import { VERSION } from '../dispatch.ts';
import { helpIf } from './_shared.ts';

const HELP = `salu doctor

Checks that salu can do its job on this machine: Claude Code is installed and reachable, you are
logged in, and the data folder is writable. Exits with 1 when something needs fixing.`;

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

  const c = checkClaude();
  if (!c.ok) {
    no('Claude Code was not found', c.problem);
  } else {
    const v = await run([c.path!, '--version']);
    if (!v.ok) no(`${c.path} does not run: ${v.out}`, 'Reinstall Claude Code: curl -fsSL https://claude.ai/install.sh | bash');
    else {
      ok(`Claude Code ${v.out} at ${c.path} ${dim(`(${c.source})`)}`);
      const a = await run([c.path!, 'auth', 'status']);
      if (a.ok) ok(`logged in ${dim(a.out)}`.trimEnd());
      else console.log(`${dim('·')} could not confirm the login (${a.out || 'no answer'}). If tickets fail to start, run \`claude\` once to log in.`);
    }
  }

  const auth = applyAuthPolicy({ ...process.env });
  if (auth.warning) console.log(`${dim('·')} ${auth.warning}`);

  try {
    ok(`data folder ${ensureHome()}`);
  } catch (e: any) {
    no(`cannot write the data folder: ${String(e?.message ?? e)}`);
  }
  console.log(bad ? `\n${bad} problem${bad === 1 ? '' : 's'} to fix.` : '\nAll good.');
  return bad ? 1 : 0;
}
