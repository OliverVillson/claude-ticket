import React from 'react';
import { Text } from 'ink';
import type { TicketView } from '../../db/types.ts';
import type { LogLine } from '../log-tail.ts';
import type { TicketDetail } from '../store.ts';
import { ago, extraTags, fmtCost, fmtDuration, labelText, modelEffort, priorityText, truncate, wrapText } from '../format.ts';
import { messageText, type Message } from '../messages.ts';
import { style as st } from '../style.ts';
import { SPINNER_FRAMES, STATUS_STYLE, paint, paintPriority, paintStatus } from '../theme.ts';
import { Frame, confirmText, hintsText, titleText } from './Frame.tsx';

export interface DetailViewProps {
  columns: number;
  rows: number;
  detail: TicketDetail;
  log: LogLine[];
  scopeName: string | null;
  now: number;
  spinner?: number;
  confirm: TicketView | null;
  message: Message | null;
}

export const DETAIL_HINTS: Array<[string, string]> = [
  ['esc', 'back'],
  ['↑↓', 'next ticket'],
  ['e', 'edit'],
  ['d', 'delete'],
  ['r', 'run now'],
  ['q', 'quit'],
];

/** A log line in the claude transcript style: `⏺ Read(src/a.ts)`, `✓ done · 14 turns`. */
export function logLineText(l: LogLine): string {
  switch (l.kind) {
    case 'tool':
      return st.accent('⏺ ') + l.text;
    case 'text':
      return st.dim('⏺ ') + l.text;
    case 'result':
      return paint(st, 'green', '✓ ' + l.text);
    case 'error':
      return paint(st, 'red', '✗ ' + l.text);
    case 'system':
      return st.dim('⚙ ' + l.text);
    default:
      return st.dim(l.text);
  }
}

export function DetailView(p: DetailViewProps) {
  const { ticket: t, run } = p.detail;
  const cols = p.columns;
  const inner = Math.max(16, cols - 4);
  const info = STATUS_STYLE[t.status];
  const glyph = t.status === 'running' && p.spinner != null ? SPINNER_FRAMES[p.spinner % SPINNER_FRAMES.length]! : info.glyph;

  // Fixed lines: status line, tags line (maybe), blank, error (maybe), run summary (maybe).
  const tagBits = [modelEffort(t), ...extraTags(t), labelText(t)].filter(Boolean);
  const hasTags = tagBits.length > 0;
  const hasError = !!t.error;
  const hasRun = !!run;
  const fixed = 1 + (hasTags ? 1 : 0) + 1 + (hasError ? 1 : 0) + (hasRun ? 2 : 0);
  const logBudget = Math.min(p.log.length, Math.max(0, Math.min(8, p.rows - fixed - 3)));
  const queryBudget = Math.max(2, p.rows - fixed - logBudget);
  const queryLines = wrapText(t.query, inner);
  const shownQuery = queryLines.slice(0, queryBudget);
  const queryCut = queryLines.length - shownQuery.length;
  if (queryCut > 0) shownQuery[shownQuery.length - 1] = truncate(shownQuery[shownQuery.length - 1]! + ` … (+${queryCut} lines)`, inner);

  const runBits: string[] = [];
  if (run) {
    runBits.push(run.ended_at ? `ended ${ago(run.ended_at, p.now)}` : `started ${ago(run.started_at, p.now)}`);
    if (run.ended_at) runBits.push(fmtDuration(run.ended_at - run.started_at));
    else if (t.status === 'running') runBits.push(fmtDuration(p.now - run.started_at));
    if (run.outcome) runBits.push(run.outcome);
    if (run.turns != null) runBits.push(`${run.turns} turns`);
    if (run.cost_usd) runBits.push(fmtCost(run.cost_usd));
  }

  const lines: string[] = [];
  lines.push(
    paintStatus(st, t.status, glyph + ' ' + info.label) +
      '   ' +
      paintPriority(st, t.priority, priorityText(t.priority)) +
      st.dim(`   ${t.project}`) +
      (t.attempts ? st.dim(`   attempt ${t.attempts}`) : '') +
      (t.cost_usd ? st.dim(`   ${fmtCost(t.cost_usd)}`) : '') +
      st.dim(`   updated ${ago(t.updated_at, p.now)}`),
  );
  if (hasTags) lines.push(st.dim(tagBits.join('   ')));
  lines.push('');
  for (const l of shownQuery) lines.push(l);
  if (hasError) lines.push(paint(st, 'red', '✗ ' + truncate(t.error!.replace(/\s+/g, ' '), inner - 2)));
  if (hasRun) {
    lines.push('');
    lines.push(st.dim(`last run · ${runBits.join(' · ')}${run?.log_path ? ` · ${run.log_path}` : ''}`));
  }
  for (const l of p.log.slice(-logBudget)) lines.push('  ' + logLineText(l));

  const crumbs = [p.scopeName ?? t.project, truncate(t.name, Math.max(8, cols - 30))];
  const idText = `#${t.id}${t.session_id ? ` · session ${t.session_id.slice(0, 8)}` : ''}`;
  const footer = p.confirm
    ? { left: confirmText(`delete "${truncate(p.confirm.name, 40)}"?`) }
    : p.message
      ? { left: messageText(p.message) }
      : { left: hintsText(DETAIL_HINTS, cols - 2) };
  return (
    <Frame columns={cols} header={{ left: titleText(crumbs), right: st.dim(idText) }} footer={footer}>
      {lines.map((l, i) => (
        <Text key={i} wrap="truncate-end">
          {st.base(l || ' ')}
        </Text>
      ))}
    </Frame>
  );
}
