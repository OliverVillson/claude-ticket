import { readFileSync, statSync } from 'node:fs';
import type { Run, TicketView } from '../db/types.ts';
import { activityLines } from './activity.ts';
import { ago, fmtCost, fmtDuration, truncate, wrapText } from './format.ts';
import { ticketDenials } from '../core/allow.ts';
import { readTail, renderLogLine, type LogLine } from './log-tail.ts';
import type { Style } from './style.ts';
import { GLYPHS } from '../ui/glyphs.ts';

/**
 * The output of a ticket's run, for the properties view: what the worker answered, why it
 * failed, and the whole transcript, read from the same jsonl log `salu log` prints. Pure
 * helpers; the log is read once when the view opens (or when the file changes), never per frame.
 */

/** Longest log we parse in full; bigger ones show their last part (the answer is at the end). */
export const MAX_LOG_BYTES = 2 * 1024 * 1024;
const MAX_LINES = 5000;

export function statusHasOutput(status: string): boolean {
  return status === 'done' || status === 'failed' || status === 'blocked';
}

/** `size:mtime` of a log, a cheap key to know whether to re-read it; '' when missing. */
export function logStamp(path: string | null | undefined): string {
  if (!path) return '';
  try {
    const s = statSync(path);
    return `${s.size}:${Math.floor(s.mtimeMs)}`;
  } catch {
    return '';
  }
}

/** Display lines of a whole log (its tail when huge), capped in number. */
export function loadOutput(path: string | null | undefined): LogLine[] {
  if (!path) return [];
  let raw = '';
  try {
    raw = statSync(path).size > MAX_LOG_BYTES ? readTail(path, MAX_LOG_BYTES) : readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const out: LogLine[] = [];
  for (const line of raw.split('\n')) {
    out.push(...renderLogLine(line));
    if (out.length > MAX_LINES * 2) out.splice(0, out.length - MAX_LINES);
  }
  return out.slice(-MAX_LINES);
}

/** The worker's final answer: the last text before the closing result line (or the last text at all). */
export function finalAnswer(lines: LogLine[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.kind === 'text') return lines[i]!.text;
  }
  return null;
}

/** Number of a run counting from the oldest (matches `salu log --run N`); `runs` is newest first. */
export const runNumber = (runs: Run[], index: number) => runs.length - index;

export interface OutputParams {
  ticket: TicketView;
  runs: Run[];
  /** index into `runs` (0 = newest) */
  index: number;
  lines: LogLine[];
  width: number;
  now: number;
  st: Style;
}

/** All rows of the output section: summary on top, then the transcript. */
export function outputRows(p: OutputParams): string[] {
  const { ticket: t, runs, index, lines, width, st } = p;
  const room = Math.max(10, width - 2);
  const run = runs[index];
  const rows: string[] = [];
  if (!run) {
    rows.push(st.dim('this ticket has not run yet'));
    return rows;
  }
  const bits = [`run ${runNumber(runs, index)} of ${runs.length}`];
  bits.push(run.ended_at ? `ended ${ago(run.ended_at, p.now)}` : `started ${ago(run.started_at, p.now)}`);
  if (run.ended_at) bits.push(fmtDuration(run.ended_at - run.started_at));
  if (run.outcome) bits.push(run.outcome);
  if (run.turns != null) bits.push(`${run.turns} turns`);
  if (run.cost_usd) bits.push(fmtCost(run.cost_usd));
  rows.push(st.dim(bits.join(` ${GLYPHS.dot} `)));
  const latest = index === 0;
  if (latest && t.error && (t.status === 'failed' || t.status === 'blocked')) {
    wrapText(t.error.replace(/\s+/g, ' '), room - 2).slice(0, 6).forEach((l, i) => rows.push(st.red((i === 0 ? `${GLYPHS.failed} ` : '  ') + l)));
  }
  const denials = latest && (t.status === 'blocked' || t.status === 'failed') ? ticketDenials(t) : [];
  if (denials.length) {
    rows.push('');
    rows.push(st.yellow('needs permission'));
    for (const d of denials.slice(0, 6)) rows.push(st.text(truncate(`  ${d.tool}: ${d.input}`, room)) + st.dim(`  ${d.rule}`));
    rows.push(st.dim('  press a to allow these rules for this ticket and queue it again'));
  }
  const answer = finalAnswer(lines);
  if (answer) {
    rows.push('');
    rows.push(st.accent('result'));
    const wrapped = wrapText(answer, room);
    for (const l of wrapped.slice(0, 14)) rows.push(st.text(l));
    if (wrapped.length > 14) rows.push(st.dim(`${GLYPHS.ellipsis} +${wrapped.length - 14} more lines in the transcript`));
  }
  rows.push('');
  if (lines.length === 0) {
    rows.push(st.dim(run.log_path ? `no transcript found at ${run.log_path}` : 'this run has no log file'));
    return rows;
  }
  rows.push(st.dim(`transcript${run.log_path ? ` ${GLYPHS.dot} ${run.log_path}` : ''}`));
  rows.push(...activityLines(lines, width, st));
  return rows;
}
