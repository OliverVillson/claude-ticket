import type { Parsed } from '../args.ts';
import { checkClaude, environmentProblem, loginProblem, runningCompiled } from '../../core/claude-bin.ts';
import { kernelStatus } from '../../core/container.ts';
import { applyAuthPolicy } from '../../core/env.ts';
import { probeWindow } from '../../usage/index.ts';
import { ensureHome } from '../../core/paths.ts';
import { dim, green, red } from '../../core/ansi.ts';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { orchestratorEnvToScrub, sandboxOn, sandboxSupport } from '../../core/kernel.ts';
import { CANARY_ENV_NAME } from '../../core/sandbox-check.ts';
import { openDb } from '../../db/db.ts';
import { listRemotes } from '../../sync/store.ts';
import { unsignedWarning } from '../../sync/format.ts';
import { VERSION } from '../dispatch.ts';
import { helpIf } from './_shared.ts';

const HELP = `salu doctor

Checks that salu can do its job on this machine: Claude Code is installed and reachable, you are
logged in (it sends one tiny test request to check the login really works), and the data folder is writable. Exits with 1 when something needs fixing.

  --sandbox   also prove the kernel sandbox holds on this machine: one small ticket tries to read, write and hard-link
              canary files in your home folder and salu checks the files (uses a few haiku requests)`;

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

/** Restart this process the way `salu run` does (before anything prints): the secret set here must be gone afterwards, and the agent looks for it. */
async function restartWithCanary(p: Parsed): Promise<string | undefined> {
  if (!sandboxOn()) return undefined;
  const fileFlag = typeof p.flags['canary-file'] === 'string' ? (p.flags['canary-file'] as string) : null;
  let canaryEnvValue: string | undefined;
  if (fileFlag) {
    try {
      canaryEnvValue = readFileSync(fileFlag, 'utf8').trim();
    } catch {
      /* no canary */
    }
    rmSync(fileFlag, { force: true });
  } else if (process.env.SALU_ORCH_SCRUBBED !== '1') {
    const value = `ENV-CANARY-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
    const file = join(homedir(), `.salu-sandbox-check-env-${process.pid}`);
    const clean = orchestratorEnvToScrub(true, { ...process.env, [CANARY_ENV_NAME]: value });
    if (clean) {
      try {
        writeFileSync(file, value, { mode: 0o600 });
        const { selfCommand } = await import('../../orchestrator/index.ts');
        const { execReplace } = await import('../../core/exec.ts');
        await execReplace(selfCommand(['doctor', '--sandbox', '--canary-file', file]), clean);
      } catch {
        rmSync(file, { force: true }); // no exec here: the environment probe is reported as not tested
      }
    }
  }
  return canaryEnvValue;
}

/** `salu doctor --sandbox`: a real ticket in a throwaway sandboxed project attacks canary files in your home folder. */
async function sandboxProof(canaryEnvValue: string | undefined): Promise<number> {
  if (!sandboxOn()) {
    console.log(`${red('✗')} SALU_SANDBOX is off, so workers would not run in the kernel; there is nothing to prove`);
    return 1;
  }
  const sb = sandboxSupport();
  if (!sb.ok) {
    console.log(`${red('✗')} the kernel sandbox cannot run here`);
    console.log(`  ${dim(sb.problem ?? '')}`);
    return 1;
  }
  console.log(`\n${dim('Sandbox proof: one small haiku ticket in a throwaway sandboxed project tries to read, write and link files in your home folder (canary files, removed afterwards)...')}`);
  const { runSandboxCheck } = await import('../../core/sandbox-check.ts');
  const { selectRunner } = await import('../../orchestrator/worker.ts');
  const probes = await runSandboxCheck(await selectRunner(), { onLine: () => process.stdout.write('.'), canaryEnvValue });
  console.log('');
  let failed = 0;
  for (const pr of probes) {
    if (pr.ok) console.log(`${green('✓')} ${pr.name} ${dim(`(${pr.detail})`)}`);
    else if (pr.soft) console.log(`${dim('·')} ${pr.name}: ${pr.detail}`);
    else {
      failed++;
      console.log(`${red('✗')} ${pr.name}`);
      console.log(`  ${dim(pr.detail)}`);
    }
  }
  return failed;
}

export async function doctor(p: Parsed): Promise<number> {
  if (helpIf(p, HELP)) return 0;
  const canary = p.flags.sandbox ? await restartWithCanary(p) : undefined;
  let bad = 0;
  const ok = (m: string) => console.log(`${green('✓')} ${m}`);
  const no = (m: string, fix?: string) => {
    bad++;
    console.log(`${red('✗')} ${m}`);
    if (fix) console.log(`  ${dim(fix)}`);
  };
  ok(`salu ${VERSION} (${runningCompiled() ? 'compiled binary' : 'running from source'})`);

  const sb = sandboxSupport();
  if (!sandboxOn()) no('SALU_SANDBOX=off: workers can change any file you can', 'Unset SALU_SANDBOX to confine workers to their project folder again.');
  else if (sb.ok) ok('workers can only change files in their project folder (the sandbox can run here; salu add project --sandbox gives them their own copy)');
  else no(`the sandbox cannot run here, so workers get file-tool confinement only and no free shell: ${sb.problem}`, 'Install it, then tickets get the full Claude Code toolset inside the fence.');

  const ks = kernelStatus();
  if (ks.engine && ks.image && ks.token) ok(`container kernel ready (${ks.gvisor ? 'gVisor' : 'default runtime'})`);
  else console.log(`${dim('·')} container kernel not ready, workers use the fenced mode: ${ks.problems[0] ?? ''}`);

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
  if (p.flags.sandbox) bad += await sandboxProof(canary);
  console.log(bad ? `\n${bad} problem${bad === 1 ? '' : 's'} to fix.` : '\nAll good.');
  return bad ? 1 : 0;
}
