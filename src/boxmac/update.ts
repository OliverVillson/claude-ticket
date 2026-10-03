import { CliError } from '../core/errors.ts';
import type { BoxConfig } from './state.ts';
import type { ControlApi, ControlReply } from './control.ts';

export interface UpdateDeps {
  control: () => ControlApi;
  say: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  waitMs?: number;
}

const versionOf = (r: ControlReply): string | undefined => (typeof r.data?.version === 'string' ? r.data.version : undefined);
const updateLine = (r: ControlReply): string | undefined => (typeof r.data?.update === 'string' ? r.data.update : undefined);
const finished = (l: string) => /^update (finished|refused|failed)/.test(l);

/**
 * `salu box update`: updates the box to the latest signed release (or a given version) and waits until it is done.
 * The box does the work and refuses anything whose signature does not verify; this only asks, then watches `status`
 * until the update unit says how it ended. Prints the version before and after and the box's own check.
 */
export async function updateBox(d: UpdateDeps, cfg: BoxConfig, version?: string): Promise<{ ok: boolean }> {
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const before = await d.control().call(cfg, 'status', {}, { timeoutMs: 120_000 }).catch((e: any) => {
    throw new CliError(`${cfg.box} did not answer: ${e?.message ?? e}`);
  });
  const was = versionOf(before);
  d.say(`${cfg.box} runs salu ${was ?? 'an unknown version'}. Asking it to update to ${version ?? 'the latest release'} (signature checked on the box)...`);
  const sent = await d.control().call(cfg, 'update', version ? { version } : {}, { timeoutMs: 120_000 });
  if (!sent.ok) {
    d.say(`✗ ${sent.message}`);
    return { ok: false };
  }
  const until = Date.now() + (d.waitMs ?? 20 * 60_000);
  let last: ControlReply | undefined;
  let waited = false;
  while (Date.now() < until) {
    await sleep(d.pollMs ?? 10_000);
    // The installer restarts the control service, so a missed answer here is normal: keep asking.
    last = await d.control().call(cfg, 'status', {}, { timeoutMs: 60_000 }).catch(() => undefined);
    if (!last) {
      if (!waited) d.say('  the box is restarting its services...');
      waited = true;
      continue;
    }
    const line = updateLine(last);
    if (line && finished(line)) break;
    last = undefined;
  }
  if (!last) {
    d.say(`✗ no final answer from ${cfg.box} yet. The update may still be running: check with salu box status --on ${cfg.box}`);
    return { ok: false };
  }
  const line = updateLine(last)!;
  const now = versionOf(last);
  const good = /^update finished/.test(line);
  d.say(`${good ? '✓' : '✗'} ${line}`);
  d.say(`  version: ${was ?? '?'} -> ${now ?? '?'}${was && now && was === now ? ' (already up to date)' : ''}`);
  d.say(`  check: ${last.message}`);
  const bad = ((last.data?.doctor as string[] | undefined) ?? []).filter((l) => l.startsWith('✗'));
  for (const l of bad) d.say(`    ${l}`);
  return { ok: good && last.ok };
}
