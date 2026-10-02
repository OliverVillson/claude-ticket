import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { runnerRoot } from '../core/runner.ts';
import { VERSION } from '../cli/dispatch.ts';
import type { BoxDeps, RunResult } from './handlers/types.ts';

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

/** Real implementation of the handlers' dependencies: runs programs directly (never through a shell). */
export function realDeps(o: Partial<BoxDeps> = {}): BoxDeps {
  const user = o.user ?? process.env.SALU_RUNNER_USER ?? 'salu';
  return {
    user,
    salu: o.salu ?? process.execPath,
    version: o.version ?? VERSION,
    tmpDir: o.tmpDir ?? join(runnerRoot(), 'box', 'tmp'),
    now: o.now ?? Date.now,
    run:
      o.run ??
      ((cmd, opt = {}) =>
        new Promise<RunResult>((resolve) => {
          const argv = opt.as && process.getuid?.() === 0 ? ['runuser', '-u', opt.as, '--', ...(opt.env ? ['env', ...Object.entries(opt.env).map(([k, v]) => `${k}=${v}`)] : []), ...cmd] : cmd;
          const child = spawn(argv[0]!, argv.slice(1), { env: { ...process.env, NO_COLOR: '1', ...(!opt.as || process.getuid?.() !== 0 ? opt.env : {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
          let out = '';
          child.stdout.on('data', (d) => (out += d));
          child.stderr.on('data', (d) => (out += d));
          const timer = setTimeout(() => child.kill('SIGKILL'), opt.timeoutMs ?? 15 * 60_000);
          child.on('error', (e) => resolve({ ok: false, out: e.message }));
          child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ ok: code === 0, out: stripAnsi(out).trim() });
          });
          child.stdin.end(opt.input ?? '');
        })),
  };
}
