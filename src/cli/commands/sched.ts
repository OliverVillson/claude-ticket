import type { Parsed } from '../args.ts';
import { flagBool } from '../args.ts';
import { openDb } from '../../db/db.ts';
import { CliError } from '../../core/errors.ts';
import { dim, green } from '../../core/ansi.ts';
import { formatForecast, forecast, lastDecisionLines } from '../../sched/forecast.ts';
import { schedMode, setSchedMode, type SchedMode } from '../../sched/stats.ts';
import { getUsageSnapshot } from '../../usage/index.ts';
import { helpIf } from './_shared.ts';

const HELP = `salu sched [off|advise|on] [--json]

The token-aware scheduler: what the queue will cost, and whether it fits your plan's windows.
  salu sched            show the mode, what finished runs taught it, the queue forecast and the last decision
  salu sched advise     (default) show what it would do; dispatch stays as it was
  salu sched on         start only tickets that fit the 5-hour window, let a smaller ticket go first when a big one
                        does not fit (at most 3 times), keep 15% of the week for \`--now\` tickets, hold the queue
                        until the reset when nothing fits, and run light tickets (labels docs, chore, typo, lint,
                        format, rename) on Sonnet, or any ticket on Sonnet when the Opus window is nearly used
  salu sched off        run the queue in order, as before
Tickets that name a model (model=) or effort high or more, and projects with their own default model, are never re-routed.
With an API key there is no plan meter: set SALU_BUDGET_USD_PER_DAY and the same rules count dollars.`;

export async function sched(p: Parsed): Promise<number> {
  if (helpIf(p, HELP)) return 0;
  const db = openDb();
  const arg = p.positional[0];
  if (arg) {
    if (arg !== 'off' && arg !== 'advise' && arg !== 'on') throw new CliError('usage: salu sched [off|advise|on]');
    setSchedMode(db, arg as SchedMode);
    console.log(`${green('✓')} scheduler ${arg}${arg === 'on' ? '' : dim(' (nothing is held back or re-routed)')}`);
    return 0;
  }
  const snap = await getUsageSnapshot({ db }).catch(() => null);
  const s = snap ?? { available: false, reason: null, reasonKind: null, plan: null, windows: [], updatedAt: 0, fetchedAt: 0, stale: true, error: null };
  const f = forecast(db, s);
  if (flagBool(p, 'json')) {
    console.log(JSON.stringify({ ...f, mode: schedMode(db) }, null, 2));
    return 0;
  }
  const lines = [...formatForecast(f, s), ...lastDecisionLines(db)];
  console.log(lines.join('\n'));
  return 0;
}
