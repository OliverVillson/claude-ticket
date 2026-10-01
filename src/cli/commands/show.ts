import type { Parsed } from '../args.ts';
import { flagBool, flagStr } from '../args.ts';
import { openDb } from '../../db/db.ts';
import { resolveTicket } from '../../core/resolve.ts';
import { CliError } from '../../core/errors.ts';
import { dim, safeText } from '../../core/ansi.ts';
import { formatAgo, formatCost, statusColor, statusIcon, statusLabel } from '../../core/format.ts';
import { ticketTags } from '../../db/types.ts';
import { threadSummary, type ThreadSummary } from '../../threads/store.ts';
import { helpIf } from './_shared.ts';

const HELP = `salu show "name" [--project P] [--id N] [--json]

What a ticket ended with: its status, the branch the work was committed on, and the worker's
short summary of what it did (or the question it is blocked on, or why it failed). Also the worker's
checklist, the decisions it asked (the open ones with their options), what it attached, and its
sub-threads.`;

const MARK = { done: '✓', doing: '◐', todo: '○' } as const;

/** The thread parts of a ticket as plain lines: checklist, decisions, outputs, links. Empty parts print nothing. */
export function threadLines(s: ThreadSummary): string[] {
  const out: string[] = [];
  if (s.checklist.length) out.push('', `checklist  ${s.checklist.map((i) => `${MARK[i.state] ?? '○'} ${safeText(i.text)}`).join('   ')}`);
  for (const d of s.decisions) {
    const answered = d.status === 'answered';
    out.push('', `decision #${d.id} ${dim(answered ? '(answered)' : '(open: the worker went on with the recommended option)')}`, `  ${safeText(d.question)}`);
    d.options.forEach((o, i) => {
      const picked = answered && d.chosen === i;
      out.push(`  ${picked ? '✓' : ' '} ${i + 1}. ${safeText(o.label)}${i === d.recommended ? dim(' (recommended)') : ''} ${dim('· ' + safeText(o.consequence))}`);
    });
    if (answered && d.answer_text) out.push(`  ${dim('answered in words:')} ${safeText(d.answer_text).slice(0, 200)}`);
  }
  if (s.outputs.length) {
    out.push('');
    for (const o of s.outputs) out.push(`output   ${o.kind.padEnd(6)} ${safeText(o.ref)}${o.title ? dim(' · ' + safeText(o.title)) : ''}`);
  }
  if (s.parent) out.push('', `part of  #${s.parent.id} ${safeText(s.parent.name)} ${dim('(' + s.parent.status + ')')}`);
  if (s.children.length) {
    out.push('', 'sub-threads');
    for (const c of s.children) out.push(`  #${c.id} ${safeText(c.name)} ${dim('(' + c.status + ')')}`);
  }
  return out;
}

export async function show(p: Parsed): Promise<number> {
  if (helpIf(p, HELP)) return 0;
  const db = openDb();
  if (!p.positional.length && !flagStr(p, 'id')) throw new CliError('usage: salu show "name"');
  const t = resolveTicket(db, p.positional[0] ?? '', { project: flagStr(p, 'project'), id: flagStr(p, 'id') });
  if (flagBool(p, 'json')) {
    console.log(JSON.stringify({ id: t.id, name: t.name, project: t.project, status: t.status, branch: t.branch ?? null, summary: t.summary ?? null, error: t.error, cost_usd: t.cost_usd, tags: ticketTags(t), ...threadSummary(db, t.id) }, null, 2));
    return 0;
  }
  const name = safeText(t.name);
  const branch = safeText(t.branch);
  const error = safeText(t.error);
  const summary = safeText(t.summary);
  const color = statusColor(t.status);
  console.log(`${color(statusIcon(t.status))} #${t.id} ${name} ${dim(`in ${safeText(t.project)} · ${statusLabel(t.status)}${t.cost_usd ? ` · ${formatCost(t.cost_usd)}` : ''} · updated ${formatAgo(t.updated_at)}`)}`);
  if (branch) console.log(`branch   ${branch} ${dim(`(git -C ${safeText(t.project_path)} log ${branch})`)}`);
  if (error) console.log(`${t.status === 'blocked' ? 'needs    ' : 'error    '}${error}`);
  if (summary) console.log(`\n${summary}`);
  else if (t.status === 'done') console.log(dim('\n(the worker left no summary)'));
  for (const l of threadLines(threadSummary(db, t.id))) console.log(l);
  return 0;
}
