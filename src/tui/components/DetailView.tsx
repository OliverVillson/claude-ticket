import React from 'react';
import { Text } from 'ink';
import type { TicketView } from '../../db/types.ts';
import type { LogLine } from '../log-tail.ts';
import type { TicketDetail } from '../store.ts';
import { ago, displayWidth, extraTags, fmtCost, fmtDuration, labelText, modelEffort, priorityText, truncate, wrapText } from '../format.ts';
import { blinkOn, withWritingCursor } from '../blink.ts';
import { messageText, type Message } from '../messages.ts';
import { layoutThread, openDecision, type ThreadExtras } from '../thread.ts';
import { style as st } from '../style.ts';
import { SPINNER_FRAMES, STATUS_STYLE, paint, paintPriority, paintStatus } from '../theme.ts';
import { Frame, confirmText, hintsText, titleText } from './Frame.tsx';
import { safeText, stripControl } from '../../core/ansi.ts';
import { GLYPHS } from '../../ui/glyphs.ts';

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
  /** conversation lines scrolled up from the newest (PgUp / PgDn) */
  back?: number;
  /** worker checklist, decision and attached outputs, once the worker tool provides them */
  extras?: ThreadExtras;
  /** outputs strip expanded (`o`) */
  showOutputs?: boolean;
}

export const DETAIL_HINTS: Array<[string, string]> = [
  ['esc', 'back'],
  ['↑↓', 'next ticket'],
  ['r', 'reply'],
  ['x', 'resolve'],
  ['o', 'outputs'],
  ['pgup/dn', 'scroll'],
  ['e', 'edit'],
  ['d', 'delete'],
  ['u', 'queue'],
  ['q', 'quit'],
];

/** A log line in the claude transcript style: `● Read(src/a.ts)`, `✓ done · 14 turns`. */
export function logLineText(l: LogLine): string {
  switch (l.kind) {
    case 'tool':
      return st.accent(GLYPHS.say + ' ') + l.text;
    case 'text':
      return st.dim(GLYPHS.say + ' ') + l.text;
    case 'result':
      return paint(st, 'green', GLYPHS.done + ' ' + l.text);
    case 'error':
      return paint(st, 'red', GLYPHS.failed + ' ' + l.text);
    case 'system':
      return st.dim(GLYPHS.dot + ' ' + l.text);
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

  const tagBits = [modelEffort(t), ...extraTags(t), labelText(t)].filter(Boolean);
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
      st.dim(`   ${safeText(t.project)}`) +
      (t.attempts ? st.dim(`   attempt ${t.attempts}`) : '') +
      (t.cost_usd ? st.dim(`   ${fmtCost(t.cost_usd)}`) : '') +
      st.dim(`   updated ${ago(t.updated_at, p.now)}`),
  );
  if (tagBits.length) lines.push(st.dim(tagBits.join('   ')));
  if (run) lines.push(st.dim(`last run · ${runBits.join(' · ')}${run.log_path ? ` · ${run.log_path}` : ''}`));
  lines.push('');

  // Everything else is the conversation, with the outputs strip and the checklist slot pinned under it.
  const room = Math.max(6, p.rows - lines.length);
  const thread = layoutThread({ detail: p.detail, log: p.log, extras: p.extras, now: p.now, spinner: p.spinner, showOutputs: p.showOutputs }, inner, room, p.back ?? 0, st);
  const body = thread.lines.slice();
  // A running ticket gets the blinking writing cursor after its newest conversation line.
  lines.push(...body);

  const crumbs = [p.scopeName ?? t.project, truncate(safeText(t.name), Math.max(8, cols - 30))];
  const scrollNote = thread.below ? `  ↓ ${thread.below} newer` : thread.above ? `  ↑ ${thread.above} older` : '';
  const idText = `#${t.id}${t.session_id ? ` · session ${t.session_id.slice(0, 8)}` : ''}${scrollNote}`;
  const footer = p.confirm
    ? { left: confirmText(`delete "${truncate(p.confirm.name, 40)}"?`) }
    : p.message
      ? { left: messageText(p.message) }
      : { left: hintsText(openDecision(p.detail) ? [['1-4', 'answer'], ...DETAIL_HINTS] : DETAIL_HINTS, cols - 2) };
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
