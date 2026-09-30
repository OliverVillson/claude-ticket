/**
 * Public entry of the orchestrator module (the contract in INTERFACES.md).
 *
 *   runOrchestrator(opts)            run the dispatch loop in this process until stopped
 *   startOrchestratorCommand(o)      what `salu run` calls: foreground view, --plain lines, or --detach
 *
 * Kept free of Ink and React so `salu run --plain` and the detached child start fast; the Ink run
 * view is only imported when a TTY asks for it, and falls back to the built-in panel if it is absent.
 */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync } from 'node:fs';
import { openDb } from '../db/db.ts';
import { getProjectById } from '../db/queries.ts';
import { CliError } from '../core/errors.ts';
import { orchestratorEnvToScrub } from '../core/kernel.ts';
import { listProjects } from '../db/queries.ts';
import { dim, green } from '../core/ansi.ts';
import { orchestratorLogPath, ensureHome } from '../core/paths.ts';
import { readStatus } from './status.ts';
import { Orchestrator, type SchedulerOptions } from './scheduler.ts';
import { attachLiveView, attachPlainView } from './view.ts';
import type { OrchestratorEvent } from './types.ts';

export type { OrchestratorEvent, WorkerLive, WorkerResult, WorkerRunner } from './types.ts';
export { Orchestrator } from './scheduler.ts';
export type { UsageHooks } from './gate.ts';

export interface OrchestratorOptions {
  projectIds?: number[];
  concurrency?: number;
  signal?: AbortSignal;
  onEvent?: (e: OrchestratorEvent) => void;
}

/** Extra knobs for tests and embedding; a superset of the contract's options. */
export type RunOrchestratorOptions = OrchestratorOptions & Partial<Omit<SchedulerOptions, 'db' | keyof OrchestratorOptions>>;

/** Run the dispatch loop until `signal` aborts (or, with `exitWhenEmpty`, the queue is drained). */
export async function runOrchestrator(opts: RunOrchestratorOptions = {}): Promise<void> {
  const orch = new Orchestrator({ db: openDb(), ...opts });
  await orch.start();
}

/** Argv that re-runs this program (bun script or compiled binary) with the given arguments. */
export function selfCommand(args: string[]): string[] {
  const script = process.argv[1];
  const isScript = !!script && !script.startsWith('/$bunfs') && !script.startsWith('B:/~BUN') && existsSync(script) && /\.(ts|tsx|js|mjs)$/.test(script);
  return isScript ? [process.execPath, script, ...args] : [process.execPath, ...args];
}

function projectIdsFromEnv(): number[] | undefined {
  const raw = process.env.SALU_PROJECT_IDS;
  if (!raw) return undefined;
  const ids = raw.split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
  return ids.length ? ids : undefined;
}

/**
 * `salu run`. Returns the process exit code.
 *  detach → start a background `salu run --plain` logging to orchestratorLogPath(), print its pid, return.
 *  plain  → one line per event on stdout.
 *  else   → the run view (Ink if available, otherwise the built-in panel) alongside the loop.
 */
export async function startOrchestratorCommand(o: { projectIds?: number[]; concurrency?: number; detach: boolean; plain: boolean }): Promise<number> {
  const db = openDb();
  const projectIds = o.projectIds ?? projectIdsFromEnv();

  const st = readStatus(db);
  if (st.alive && st.pid && st.pid !== process.pid) {
    throw new CliError(`an orchestrator is already running (pid ${st.pid}); \`salu stop\` ends it`);
  }

  // A worker's shell must not be able to read this process's environment: start over with only what workers get.
  const clean = orchestratorEnvToScrub(listProjects(db).some((p) => p.sandbox));
  if (clean && !o.detach) {
    const args = ['run', ...(o.plain ? ['--plain'] : []), ...(o.concurrency ? ['--concurrency', String(o.concurrency)] : [])];
    const [cmd, ...rest] = selfCommand(args);
    const env = { ...clean, ...(projectIds ? { SALU_PROJECT_IDS: projectIds.join(',') } : {}) };
    const child = Bun.spawn([cmd!, ...rest], { stdio: ['inherit', 'inherit', 'inherit'], env: env as Record<string, string> });
    // Ctrl-C reaches both processes; ours just waits for the child to wind down.
    for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => child.kill(sig));
    return await child.exited;
  }
  if (o.detach) return detach({ projectIds, concurrency: o.concurrency });

  const orch = new Orchestrator({ db, projectIds, concurrency: o.concurrency });
  let signals = 0;
  const onSignal = (name: string) => () => {
    if (++signals > 1) process.exit(130); // a second signal means "now"
    orch.stop(name);
  };
  const sigint = onSignal('SIGINT');
  const sigterm = onSignal('SIGTERM');
  process.on('SIGINT', sigint);
  process.on('SIGTERM', sigterm);

  let detachView: (() => void) | null = null;
  let runView: Promise<void> | null = null;
  try {
    if (o.plain) {
      detachView = attachPlainView(orch);
    } else {
      let tui: any = null;
      try {
        tui = await import('../tui/index.tsx');
      } catch {
        tui = null;
      }
      if (tui?.openRunView) {
        runView = tui.openRunView({
          projectIds,
          concurrency: orch.concurrency,
          stop: () => orch.stop('q pressed'),
          subscribe: (fn: (e: OrchestratorEvent) => void) => orch.on(fn),
        });
      } else {
        detachView = attachLiveView(orch, db);
      }
    }
    await orch.start();
    if (runView) await Promise.race([runView, new Promise((r) => setTimeout(r, 500))]);
  } finally {
    detachView?.();
    process.off('SIGINT', sigint);
    process.off('SIGTERM', sigterm);
  }
  return 0;
}

function detach(o: { projectIds?: number[]; concurrency?: number }): number {
  const db = openDb();
  ensureHome();
  const args = ['run', '--plain'];
  if (o.concurrency) args.push('--concurrency', String(o.concurrency));
  const env: Record<string, string | undefined> = orchestratorEnvToScrub(listProjects(db).some((p) => p.sandbox)) ?? { ...process.env };
  if (o.projectIds?.length === 1) {
    const p = getProjectById(db, o.projectIds[0]!);
    if (p) args.push(p.name);
  } else if (o.projectIds?.length) {
    env.SALU_PROJECT_IDS = o.projectIds.join(',');
  }
  const logPath = orchestratorLogPath();
  const fd = openSync(logPath, 'a');
  const [cmd, ...rest] = selfCommand(args);
  const child = spawn(cmd!, rest, { detached: true, stdio: ['ignore', fd, fd], env: env as NodeJS.ProcessEnv });
  child.unref();
  closeSync(fd);
  console.log(`${green('✓')} orchestrator started in the background ${dim(`pid ${child.pid} · log ${logPath} · \`salu stop\` ends it`)}`);
  return 0;
}
