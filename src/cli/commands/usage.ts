import type { Parsed } from '../args.ts';
import { flagBool } from '../args.ts';
import { openDb } from '../../db/db.ts';
import { dim, green, red, yellow } from '../../core/ansi.ts';
import { formatUsageLines, getUsageSnapshot } from '../../usage/index.ts';
import type { UsageSnapshot } from '../../usage/index.ts';
import { helpIf } from './_shared.ts';

const HELP = `salu usage [--json] [--refresh]

How much of your Claude plan's usage is left: the 5-hour session window, the weekly window,
and per-model weekly windows (Opus, Sonnet) when your plan has them, with reset times.
Read without a model turn, cached for a minute. --refresh reads it again right now.
Not available with an API key or a third-party provider (only subscription plans report usage).`;

/** Colour a plain usage line by how full its window is. */
export function colorUsageLine(line: string, snap: UsageSnapshot): string {
  const w = snap.windows.find((x) => line.startsWith(x.label));
  if (!w) return dim(line);
  const c = w.status === 'rejected' || (w.percentUsed ?? 0) >= 95 ? red : w.status === 'warning' || (w.percentUsed ?? 0) >= 80 ? yellow : green;
  return c(line);
}

export async function usage(p: Parsed): Promise<number> {
  if (helpIf(p, HELP)) return 0;
  const db = openDb();
  const snap = await getUsageSnapshot({ db, force: flagBool(p, 'refresh') });
  if (flagBool(p, 'json')) {
    console.log(JSON.stringify(snap, null, 2));
    return 0;
  }
  const lines = formatUsageLines(snap);
  if (!snap.available) {
    console.log(dim(lines[0]));
    return 0;
  }
  console.log(lines.map((l, i) => (i === 0 && snap.plan ? dim(l) : colorUsageLine(l, snap))).join('\n'));
  return 0;
}
