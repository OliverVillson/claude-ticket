import React, { useState } from 'react';
import { Text, useInput } from 'ink';
import type { Turn, TicketView } from '../../db/types.ts';
import { Frame, hintsText, titleText } from './Frame.tsx';
import { TextField } from './TextField.tsx';
import { style as st } from '../style.ts';
import { inkColor } from '../../ui/theme.ts';
import { truncate, wrapText } from '../format.ts';
import { stripControl } from '../../core/ansi.ts';

export interface ReplyViewProps {
  columns: number;
  rows: number;
  ticket: TicketView;
  /** the latest turns, shown above the prompt so you can see what you are answering */
  turns: Turn[];
  error: string | null;
  onSubmit: (message: string) => void;
  onCancel: () => void;
  onChange?: () => void;
}

export const REPLY_HINTS: Array<[string, string]> = [
  ['⏎', 'send'],
  ['esc', 'cancel'],
];

/** The last worker reply, wrapped and cut to fit. */
export function lastReplyLines(turns: Turn[], width: number, max: number): string[] {
  const last = [...turns].reverse().find((t) => t.role === 'assistant');
  if (!last || max < 1) return [];
  const lines = wrapText(stripControl(last.body).trim(), width);
  if (lines.length <= max) return lines;
  const cut = lines.slice(0, max);
  cut[max - 1] = truncate(cut[max - 1]! + ` … (+${lines.length - max} lines)`, width);
  return cut;
}

/** One-line prompt inside the same frame: answer or continue a ticket. Enter sends, Esc cancels. */
export function ReplyView(p: ReplyViewProps) {
  const [value, setValue] = useState('');
  useInput((_input, key) => {
    if (key.escape) return p.onCancel();
    if (key.return && value.trim()) p.onSubmit(value.trim());
  });
  const inner = Math.max(16, p.columns - 4);
  const shown = lastReplyLines(p.turns, inner, Math.max(2, p.rows - 6));
  const pendingNote = p.ticket.status === 'blocked' && p.ticket.error ? p.ticket.error : null;
  return (
    <Frame columns={p.columns} header={{ left: titleText([p.ticket.project, truncate(p.ticket.name, Math.max(8, p.columns - 30)), 'reply']) }} footer={{ left: hintsText(REPLY_HINTS, p.columns - 2) }}>
      {(shown.length ? shown : wrapText(stripControl(p.ticket.query).trim(), inner).slice(0, 3)).map((l, i) => (
        <Text key={i} wrap="truncate-end">
          {st.dim('  ') + st.text(l || ' ')}
        </Text>
      ))}
      {pendingNote ? <Text wrap="truncate-end">{st.dim('  asked: ' + truncate(stripControl(pendingNote).replace(/\s+/g, ' '), inner - 9))}</Text> : null}
      <Text> </Text>
      <Text wrap="truncate-end">
        <Text color={inkColor('accent')}>{'❯ '}</Text>
        <TextField value={value} onChange={(v) => { setValue(v); p.onChange?.(); }} focus placeholder="your message: the worker keeps the same session" width={Math.max(10, p.columns - 6)} />
      </Text>
      {p.error ? (
        <Text color={inkColor('error')} wrap="truncate-end">
          {'✗ ' + p.error}
        </Text>
      ) : (
        <Text> </Text>
      )}
    </Frame>
  );
}
