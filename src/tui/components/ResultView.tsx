import React from 'react';
import { Text } from 'ink';
import { style as st } from '../style.ts';
import { Frame, hintsText, titleText } from './Frame.tsx';

export interface ResultViewProps {
  columns: number;
  rows: number;
  scopeName: string | null;
  command: string;
  lines: string[];
  ok: boolean;
  offset: number;
}

/** Multi-line output of a command typed into the command line (help, status, lists, errors). */
export function ResultView(p: ResultViewProps) {
  const shown = p.lines.slice(p.offset, p.offset + p.rows);
  const more = p.lines.length - p.offset - shown.length;
  const body = shown.map((l, i) => (
    <Text key={i} wrap="truncate-end">
      {st.base(p.ok ? l || ' ' : st.yellow(l) || ' ')}
    </Text>
  ));
  const foot = [['↑↓', 'scroll'], ['esc', 'close']] as Array<[string, string]>;
  return (
    <Frame
      columns={p.columns}
      header={{ left: titleText([p.scopeName ?? 'all projects', 'output']), right: st.dim(p.command) }}
      footer={{ left: hintsText(foot, p.columns - 2), right: more > 0 ? st.dim(`↓ ${more} more`) : undefined }}
    >
      {body}
    </Frame>
  );
}
