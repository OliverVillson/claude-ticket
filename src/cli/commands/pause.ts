import type { Parsed } from '../args.ts';
import { openDb } from '../../db/db.ts';
import { wakeOrchestrator } from '../../db/queries.ts';
import { pidAlive, readStatus } from '../../orchestrator/status.ts';
import { clearPause, enterManualPause } from '../../usage/index.ts';
import { dim, green, magenta } from '../../core/ansi.ts';
import { helpIf } from './_shared.ts';

export async function pause(p: Parsed): Promise<number> {
  if (helpIf(p, 'salu pause\n\nStops dispatching new workers after the current ones finish. `salu resume` continues.')) return 0;
  const db = openDb();
  enterManualPause(db); // keeps an active rate-limit pause underneath
  wakeOrchestrator();
  const st = readStatus(db);
  console.log(`${magenta('‖')} paused ${dim(st.alive ? `(${st.workers.length} running worker${st.workers.length === 1 ? '' : 's'} will finish)` : '(orchestrator not running; it will start paused)')}`);
  return 0;
}

export async function resume(p: Parsed): Promise<number> {
  if (helpIf(p, 'salu resume\n\nClears a pause (manual or rate-limit) and dispatches again right away.')) return 0;
  const db = openDb();
  clearPause(db);
  wakeOrchestrator();
  const st = readStatus(db);
  console.log(`${green('▶')} resumed ${dim(st.alive ? '' : '(orchestrator not running: salu run)')}`);
  return 0;
}

export async function stop(p: Parsed): Promise<number> {
  if (helpIf(p, 'salu stop\n\nStops a detached orchestrator. Running workers are interrupted and their tickets go back to the queue.')) return 0;
  const db = openDb();
  const st = readStatus(db);
  if (!st.alive || !st.pid) {
    console.log(dim('orchestrator is not running'));
    return 0;
  }
  try {
    process.kill(st.pid, 'SIGTERM');
  } catch {
    /* ignore */
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && pidAlive(st.pid)) await Bun.sleep(100);
  console.log(`${green('✓')} stopped orchestrator ${dim(`pid ${st.pid}`)}`);
  return 0;
}
