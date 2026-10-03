import { readFileSync, statfsSync } from 'node:fs';
import { runnerRoot } from '../../core/runner.ts';
import { listProjects } from './projects.ts';
import { updateStatusFile } from './update.ts';
import type { BoxDeps, Handler } from './types.ts';

export interface BoxSnapshot {
  version: string;
  disk: { freeGb: number; totalGb: number } | null;
  tickets: { todo: number; running: number; blocked: number; done: number };
  projects: Array<{ project: string; service: string; sync: string | null; todo: number; running: number; blocked: number; done: number }>;
}

export function diskInfo(dir: string): BoxSnapshot['disk'] {
  try {
    const s = statfsSync(dir);
    return { freeGb: Math.round((s.bavail * s.bsize) / 1e8) / 10, totalGb: Math.round((s.blocks * s.bsize) / 1e8) / 10 };
  } catch {
    return null;
  }
}

/** What the heartbeat and `status` both report: version, disk, tickets and each project's service state. */
export async function snapshot(deps: BoxDeps): Promise<BoxSnapshot> {
  const projects = await listProjects(deps);
  const tickets = { todo: 0, running: 0, blocked: 0, done: 0 };
  for (const p of projects) for (const k of Object.keys(tickets) as Array<keyof typeof tickets>) tickets[k] += p[k];
  return { version: deps.version, disk: diskInfo(runnerRoot()), tickets, projects };
}

/** How the last `update` went (written by the update unit), if one ran. */
function lastUpdateLine(): string | undefined {
  try {
    return readFileSync(updateStatusFile(), 'utf8').trim().slice(0, 200) || undefined;
  } catch {
    return undefined;
  }
}

/** `status`: the snapshot plus the lines of `salu doctor --sandbox`, so the Mac can show what is wrong in words. */
export const status = (deps: BoxDeps): Handler => async () => {
  const [snap, doctor] = await Promise.all([snapshot(deps), deps.run([deps.salu, 'doctor', '--sandbox'], { as: deps.user, timeoutMs: 120_000 })]);
  const lines = doctor.out.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 60);
  const failing = lines.filter((l) => l.startsWith('✗')).length;
  const sick = snap.projects.filter((p) => p.service !== 'active').map((p) => p.project);
  const message = [
    `salu ${snap.version}`,
    snap.disk ? `${snap.disk.freeGb} of ${snap.disk.totalGb} GB free` : null,
    `${snap.projects.length} project${snap.projects.length === 1 ? '' : 's'}, ${snap.tickets.running} running, ${snap.tickets.todo} queued`,
    failing ? `${failing} problem${failing === 1 ? '' : 's'} in the check (see data.doctor)` : 'all checks pass',
    sick.length ? `not running: ${sick.join(', ')}` : null,
  ].filter(Boolean).join(' · ');
  return { ok: failing === 0 && !sick.length, message, data: { ...snap, doctor: lines, update: lastUpdateLine() } };
};
